// This hits an access error due to Deno permissions
await Deno.writeTextFile("./hello.txt", "Hello World!");
console.log("huh, user script should not reach here");