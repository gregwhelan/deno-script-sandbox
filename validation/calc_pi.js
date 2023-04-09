// takes about 16 seconds on M1 Macbook Air
function calculatePi() {
  let i = 1n;
  let x = 3n * (10n ** 100000n);
  let pi = x;
  while (x > 0) {
    x = x * i / ((i + 1n) * 4n);
    pi += x / (i + 2n);
    i += 2n;
  }
  return pi;
}

console.log(calculatePi());
