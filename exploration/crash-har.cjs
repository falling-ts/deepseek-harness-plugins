#!/usr/bin/env node
// READ-ONLY probe: extract CRASH-HARNESS + surrounding context lines from the
// dev log so the captured failure-object dumps can be inspected verbatim.
'use strict';
const fs = require('fs');
const LOG = 'D:/deepseek-harness-plugins/dsh-web-dev-3180.log';
const lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/);
const want = process.argv[2] === 'all' ? Infinity : Number(process.argv[2] || 3);
let shown = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('CRASH-HARNESS')) {
    if (shown >= want) break;
    const start = Math.max(0, i - 6);
    console.log('===== CRASH-HARNESS hit at file-line ' + (i + 1) + ' =====');
    for (let j = start; j < Math.min(lines.length, i + 6); j++) {
      console.log(j + 1 + ': ' + lines[j]);
    }
    shown++;
  }
}
if (shown === 0) console.log('(no CRASH-HARNESS lines found)');
