import * as uuid from "https://deno.land/std@0.182.0/uuid/mod.ts";

console.log(uuid.v1.generate());

function calculatePi() {
  let i = 1n;
  let x = 3n * (10n ** 1000020n);
  let pi = x;
  while (x > 0) {
    x = x * i / ((i + 1n) * 4n);
    pi += x / (i + 2n);
    i += 2n;
  }
console.log("wtf");

  return pi.toString();
}

console.log(calculatePi());
