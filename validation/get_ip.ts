const addrs = await Deno.resolveDns("localhost", "A");
const ipv4Addrs = addrs.filter((addr) => addr?.hostname === "localhost" && addr?.ipAddr?.kind === 4);
const localIp = ipv4Addrs[0]?.ipAddr;

if (localIp) {
  console.log(`Local IP address: ${localIp}`);
} else {
  console.error("Failed to get local IP address");
  Deno.exit(1);
}
