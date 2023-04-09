// This hits a heap limit error due to `--v8-flags=--max-old-space-size` (importantly, the API doesn't crash)
const a = [];
for (let i = 0; i < 9000000000; i++) {
    a.push(i)
}