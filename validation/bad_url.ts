// This won't error but the proxy returns (400, "only these URLs are allowed ...")
const res = await fetch("https://notpermitted.tinkr.dev");
console.log(res.status, await res.text())