const [filePath] = Deno.args;

if (!filePath) {
    console.error("Please provide a file path");
    Deno.exit(1);
}

console.log(`shipping file: ${filePath}`);

let fileContents;

try {
    fileContents = await Deno.readTextFile(filePath);
} catch (error) {
    console.error(`Error reading file: ${error.message}`);
    Deno.exit(1)
}

//const denoServerUrl = "http://deno-server-001.fly.dev/script";
// const denoServerUrl = "http://159.223.200.161:3003/script";
const denoServerUrl = "http://localhost:3003/script"


const res = await fetch(denoServerUrl, {
    method: "POST",
    body: fileContents,
    headers: {
        "x-coderunner-signature-v1": "1"
    },
});

const responseText = await res.text();
console.log("status: " + res.status);
console.log(responseText)
