// Probe: what does AbortSignal.timeout do at/above the 2^31-1 boundary, and is it
// ever silently shortened? Established empirically for the force-compact review.
const cases = [4294967295, 4294967294, 2147483647, 2147483648]

for (const ms of cases) {
  const started = Date.now()
  const signal = AbortSignal.timeout(ms)
  await new Promise((resolve) => setTimeout(resolve, 250))
  console.log(
    `  delay=${String(ms).padStart(10)}  aborted_after_250ms=${String(signal.aborted).padStart(5)}  ` +
    `elapsed=${Date.now() - started}ms`,
  )
}
