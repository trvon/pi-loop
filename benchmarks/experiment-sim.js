#!/usr/bin/env node
/**
 * Synthetic benchmark — mimics a research experiment with periodic progress output.
 * Prints "iteration N/M, metric=0.XX" every 200ms for 30 iterations.
 */

const TOTAL = 30;
const INTERVAL_MS = 200;

let iteration = 0;

const timer = setInterval(() => {
  iteration++;
  const metric = (Math.random() * 0.5 + 0.3).toFixed(4);
  console.log(`iteration ${iteration}/${TOTAL}, loss=${metric}, timestamp=${Date.now()}`);

  if (iteration >= TOTAL) {
    console.log(`experiment complete: best loss=0.${Math.floor(Math.random() * 1000).toString().padStart(4, "0")}`);
    clearInterval(timer);
    process.exit(0);
  }
}, INTERVAL_MS);

process.on("SIGTERM", () => {
  console.log("experiment interrupted — saving checkpoint");
  clearInterval(timer);
  process.exit(0);
});

console.log("experiment starting: total_iterations=30, interval_ms=200");
