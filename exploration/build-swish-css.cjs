// Build the dark-mode SWISH_CSS constant from a single hex table, then emit
// both the readable swish.css (human version) and the compact inline form used
// inside web/client.js's SWISH_CSS string literal. Run once; output is meant to
// be pasted verbatim into the two files. Keeps the three copies (ui-signal.js
// WORKING_COLORS/PINNED_COLORS, client.js SWISH_HEXES, swish.css + inline
// SWISH_CSS) provably consistent because all derive from ONE array here.

const fs = require('fs');
const path = require('path');

// ── Single source of truth: identical order & values as src/core/ui-signal.js ──
// Index 0..19 = WORKING_COLORS; 20 = PINNED_COLORS.compressing; 21 = PINNED_COLORS.done
const PALETTE = [
  ["#1e40af", "royal blue"],
  ["#1e3a8a", "deep blue"],
  ["#312e81", "indigo"],
  ["#4c1d95", "violet"],
  ["#581c87", "purple"],
  ["#8318a3", "plum"],
  ["#86198f", "orchid"],
  ["#9d174d", "magenta"],
  ["#9f1239", "pink"],
  ["#991b1b", "rose"],
  ["#9a3412", "crimson"],
  ["#92400e", "scarlet"],
  ["#854d0e", "rust"],
  ["#4d7c0f", "ochre-gold"],
  ["#3f6212", "olive"],
  ["#166534", "moss"],
  ["#065f46", "pine"],
  ["#0e7490", "teal"],
  ["#155e75", "cyan"],
  ["#172554", "navy"],
  ["#9b1c2b", "deep burgundy-red (compressing)"],
  ["#2f6f52", "muted pine-green (done)"],
];

// ── Compact form: one-line inline CSS literal (browser-executable) ────────────
const BAND = "var(--dsw-fc-swish-band,#ffffff)";
const compactBlocks = PALETTE.map(([hex, _label], i) => {
  const n = String(i).padStart(2, "0");
  return `@keyframes falling-ts-swish-${n}{from{background-position:100% 0}to{background-position:0 0}}.falling-ts-swish-${n}{animation-name:falling-ts-swish-${n}!important;background-image:linear-gradient(90deg,${hex} 0%,${hex} 40%,${BAND} 50%,${hex} 60%,${hex} 100%)!important}`;
});
const compactClockRule = ".turnStatusClock[data-fc-bg]{color:attr(data-fc-bg)!important;-webkit-text-fill-color:attr(data-fc-bg)!important}";
// NOTE: the original file ends with a slightly different selector — verify against
// the existing line before replacing. We emit BOTH forms below and let the paste
// step pick whichever matches the current tail.

const compactCss = compactBlocks.join("") + compactClockRule;
console.error("COMPACT length:", compactCss.length);
console.error(compactCss);

// ── Readable form: human-friendly swish.css body (mirrors prior file structure) ─
const readable = PALETTE.map(([hex, label], i) => {
  const n = String(i).padStart(2, "0");
  const tag = i < 20 ? "working" : (i === 20 ? "compressing" : "done");
  return [
    ``,
    `/* ---------- ${n} · ${tag} · ${hex} (${label}) ---------- */`,
    `@keyframes falling-ts-swish-${n} { from { background-position: 100% 0; } to { background-position: 0 0; } }`,
    `.falling-ts-swish-${n} {`,
    `  animation-name: falling-ts-swish-${n} !important;`,
    `  background-image: linear-gradient(90deg, ${hex} 0%, ${hex} 40%, ${BAND} 50%, ${hex} 60%, ${hex} 100%) !important;`,
    `}`,
    ``,
  ].join("\n");
}).join("");

console.error("\n=== READABLE BODY (paste between header comment and trailing note) ===\n");
console.log(readable);
