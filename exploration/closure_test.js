// Test 1: Basic closure - does the closure survive after outer function returns?
function counter() {
  let n = 0;
  return () => { n++; return n; };
}
const c1 = counter();
const c2 = counter();
console.log('--- Basic closure ---');
console.log(c1(), c1(), c1());
console.log(c2(), c2());

// Test 2: Shared closure state
function makeCounter(initial) {
  let count = initial;
  return {
    inc: () => ++count,
    dec: () => --count,
    peek: () => count,
  };
}
const ctr = makeCounter(10);
console.log('\n--- Shared state ---');
console.log(ctr.peek());
console.log(ctr.inc());
console.log(ctr.inc());
console.log(ctr.dec());
console.log(ctr.peek());

// Test 3: Closure over large array vs. extracting scalar
const bigArray = [];
for (let i = 0; i < 1000000; i++) bigArray.push({ id: i, val: Math.random() });

function delayRef(array) {
  // Closes over the WHOLE array
  return () => array.length;
}
function delayScalar(array) {
  const len = array.length;
  return () => len;
}

const refFn = delayRef(bigArray);
const scalFn = delayScalar(bigArray);

setTimeout(() => {
  console.log('\n--- Delayed callbacks ---');
  console.log('refFn():', refFn());
  console.log('scalFn():', scalFn());

  // Demonstrate scoping difference: var vs let in loop
  console.log('\n--- Loop closure: var ---');
  for (var i = 0; i < 3; i++) {
    setTimeout(() => console.log('var i =', i), i * 10);
  }
  console.log('--- Loop closure: let ---');
  for (let j = 0; j < 3; j++) {
    setTimeout(() => console.log('let j =', j), j * 10);
  }
}, 50);
