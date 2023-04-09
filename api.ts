import {Semaphore} from "https://deno.land/x/semaphore@v1.1.2/semaphore.ts";
import { type ConnInfo } from "https://deno.land/std@0.125.0/http/server.ts";
import {serve} from "https://deno.land/std@0.176.0/http/mod.ts";
import {createScript, safeURL, safeURLs} from "./utils.ts";

// Sandboxed validation are only allowed to reach the internet via
// this proxy (enforced via --allow-net).
const PROXY_LOCATION = "127.0.0.1:3003";

const SCRIPT_TIME_LIMIT = 1000; // ms
const SCRIPT_MEMORY_LIMIT = 64; // mb
const SCRIPT_REQUEST_LIMIT = 2; // total number of requests per script
const SCRIPT_SIZE_LIMIT = 1_000_000; // 1MB in bytes

const CONCURRENCY_LIMIT = 3;
const conurrencyMutex = new Semaphore(CONCURRENCY_LIMIT);

// Track validation that are running so that we can:
// - auth requests to the proxy
// - limit the number of requests per script
const inFlightScriptIds: Record<string, number> = {};

const SCRIPT_ROUTE = new URLPattern({pathname: "/script"});
const PROXY_ROUTE = new URLPattern({pathname: "/proxy"});

async function handler(req: Request, connectionInfo: ConnInfo) {
    if (SCRIPT_ROUTE.exec(req.url)) {
        return await launchDenoProcess(req);
    } else if (PROXY_ROUTE.exec(req.url)) {
        return await proxy(req, connectionInfo);
    }

    return new Response("hm, unknown route", {status: 404});
}

function badRequest(httpResponseCode: number, message: string) {
    return new Response(
        JSON.stringify({status: message}),
        {status: httpResponseCode});
}

function kill(process: Deno.Process, scriptId: string) {
    try {
        // N.B. adding a kill signal number parameter results in kill not working.
        process.kill();
    } catch (e) {
        console.error(`exception killing process ${process.pid}, scriptId: ${scriptId}`, e);
        return false;
    }
    return true;
}

function close(process: Deno.Process, scriptId: string) {
    try {
        process.close();
    } catch (e) {
        if (!e.message.includes("ESRCH")) { // Might have already closed
            console.error(`couldn't close ${scriptId}`, {error: e});
        }
        return false;
    }
    return true;
}

async function launchDenoProcess(req: Request) {
    const signatureHeader = req.headers.get("x-coderunner-signature-v1");
    if (!signatureHeader) {
        console.log("Signature header not found");
        return badRequest(401, "invalid signature");
    }

    const code = await req.text();
    if (code.length > SCRIPT_SIZE_LIMIT) {
        console.log("script too large");
        return badRequest(413, "code too large");
    }
    const startTime = Date.now();
    const {scriptId, scriptPath} = await createScript(code);
    inFlightScriptIds[scriptId] = 0;
    let scriptProcess: Deno.Process = null;
    let killed = false;
    let timeoutId: number = null;
    try {
        const cmd = [
            "nice",
            "-n",
            "10",
            "deno",
            "run",
            `--v8-flags=--max-old-space-size=${SCRIPT_MEMORY_LIMIT}`,
            `--allow-read=${scriptPath}`,
            `--allow-net=${PROXY_LOCATION}`,
            // `--allow-net`, // block undesirable outbound traffic with IP filters and DNS
            "./sandbox.ts",
            `scriptId=${scriptId}`,
            `scriptPath=${scriptPath}`,
        ];
        // console.log("cmd: ", cmd.join(" "));
        const release = await conurrencyMutex.acquire();
        scriptProcess = Deno.run({cmd, stderr: "piped", stdout: "piped"});
        release();

        timeoutId = setTimeout(() => {
            killed ||= kill(scriptProcess, scriptId);
            console.log(`timeout ${scriptId}  after ${Date.now() - startTime}ms`);
        }, SCRIPT_TIME_LIMIT);

        const [processStatus, stdout, stderr] = await Promise.all([
            scriptProcess.status(),
            scriptProcess.output(),
            scriptProcess.stderrOutput(),
        ]);

        // if killed, return 400 (Bad Request), as this will most typically mean the script takes too
        // long to run, and is a user error -- they should not retry. With more sophisticated monitoring
        // we can return 503 Service Unavailable if system is experiencing resource exhaustion.
        let httpResponseCode;
        let statusMessage;
        let logFinishedMessage;

        if (processStatus.code !== 0 && !killed) {
            // N.B. as of April 2023 Deno returns a 0 status code even when the script attempts to write a file.
            // Other permissions errors do have non 0 status code (network: 1, cpu utilization: 155)
            httpResponseCode = 400;
            statusMessage = "script exited with non-zero status code";
            // console.warn("script exited with non-zero status code", processStatus);
            console.log(`script  ${scriptId}  ${code.length} bytes, took ${Date.now() - startTime} ms - failed: `, processStatus);
        } else {
            httpResponseCode = killed ? 400 : 200;
            statusMessage = killed ? "timed out" : "ok";
            logFinishedMessage = killed ? "killed" : "completed";
            console.log(`script  ${scriptId}  ${code.length} bytes, took ${Date.now() - startTime} ms - ${logFinishedMessage}`);
        }

        const responsePayload = {
            stdout: new TextDecoder().decode(stdout),
            stderr: new TextDecoder().decode(stderr),
            status: statusMessage,
            debug: processStatus
        };

        return new Response(
            JSON.stringify(responsePayload),
            {
                status: httpResponseCode,
            },
        );
    } catch (e) {
        // ensure any uncaught exceptions do not result in allowing the script to run forever
        kill(scriptProcess, scriptId);
        console.error(`uncaught exception in script launcher, killed process ${scriptProcess.pid}`, e);
    } finally {
        delete inFlightScriptIds[scriptId];
        close(scriptProcess, scriptId);
        if (timeoutId) {
            clearTimeout(timeoutId);
        }

        try {
            await Deno.remove(scriptPath);
        } catch (e) {
            console.error(`couldn't remove ${scriptPath}`, {error: e, code});
        }
    }
}

function clientIP(connectionInfo: ConnInfo) {
    // assumes NetAddr (https://deno.land/api@v1.32.3?s=Deno.Addr)
    return connectionInfo.remoteAddr.hostname;
}



async function proxy(req: Request, connectionInfo: ConnInfo) {
    const clientIPAddress = clientIP(connectionInfo);
    if (clientIPAddress !== "127.0.0.1") {
        console.warn("ignoring proxy request from " + clientIPAddress);
        return new Response(
            'forbidden',
            {status: 403},
        );
    }
    const resource = req.headers.get("x-script-fetch") || "missing-resource";
    const scriptId = req.headers.get("x-script-id");
    // Check the request came from a real script
    if (scriptId === null || inFlightScriptIds[scriptId] === undefined) {
        return new Response(
            'bad auth',
            {status: 400},
        );
    }

    // Apply some limits
    if (++inFlightScriptIds[scriptId] > SCRIPT_REQUEST_LIMIT) {
        return new Response(
            `too many requests, max requests per script: ${SCRIPT_REQUEST_LIMIT}`,
            {status: 400},
        );
    }
    if (!safeURL(resource)) {
        console.log(`blocked ${scriptId}  ` + resource);
        return new Response(
            `only these URLs are allowed: [${safeURLs.join(", ")}]`,
            {status: 400},
        );
    } else {
        console.log(`proxy   ${scriptId}  ${resource}`);
    }

    try {
        const controller = new AbortController();
        const {signal} = controller;
        setTimeout(() => {
            try {
                controller.abort();
            } catch { /* */
            } // The fetch might have already ended
        }, SCRIPT_TIME_LIMIT);
        const proxiedRes = await fetch(resource, {
            method: req.method,
            headers: {
                ...req.headers,
            },
            body: req.body,
            signal,
        });

        return new Response(proxiedRes.body, {
            ...proxiedRes,
        });
    } catch (e) {
        console.log(`error while proxying ${resource}`, {error: e});
        return new Response("", {status: 500});
    }
}

serve(handler, {port: 3003});
