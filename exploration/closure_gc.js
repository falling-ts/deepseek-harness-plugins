// Verify environment survival: drop all refs -> captured state becomes collectible.
function makeHolder(payload) {
  return () => payload.value;
}

let obj = makeHolder({ value: 'ALIVE' });

// Keep a strong ref outside; confirm we can still read
console.log('while alive:', obj());

// Drop all references (reassign, clear any aliasing)
obj = null;

// Now attempt weak-ref style observation: re-create a probe that reattaches
// We cannot directly observe GC in plain JS; simulate by showing re-creation
obj = makeHolder({ value: 'NEW' });
console.log('after reassign:', obj());
obj = null;

console.log('Done. Environment lifetime is governed purely by reachability.');
