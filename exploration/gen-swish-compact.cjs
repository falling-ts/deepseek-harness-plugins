// One-shot generator for the NEW compact SWISH_CSS (dark palette).
// Tail selector kept IDENTICAL to the previous line so the replacement is a
// pure hex-substitution in terms of observable behavior. Output lands in
// swish-new-compact.txt for manual paste into web/client.js.
"use strict";
const fs = require("fs");
const PALETTE = [
  "#1e40af","#1e3a8a","#312e81","#4c1d95","#581c87",
  "#8318a3","#86198f","#9d174d","#9f1239","#991b1b",
  "#9a3412","#92400e","#854d0e","#4d7c0f","#3f6212",
  "#166534","#065f46","#0e7490","#155e75","#172554",
  "#9b1c2b","#2f6f52",
];
const BAND = "var(--dsw-fc-swish-band,#ffffff)";
function block(hex, i) {
  const n = String(i).padStart(2, "0");
  return (
    "@keyframes falling-ts-swish-" + n + "{from{background-position:100% 0}to{background-position:0 0}}" +
    ".falling-ts-swish-" + n + "{animation-name:falling-ts-swish-" + n + "!important;" +
    "background-image:linear-gradient(90deg," + hex + " 0%," + hex + " 40%," + BAND + " 50%," + hex + " 60%," + hex + " 100%)!important}"
  );
}
const TAIL = ".turnStatus[data-fc-bg] .turnStatusClock,[data-fc-bg] span:last-of-type{color:attr(data-fc-bg)!important;-webkit-text-fill-color:attr(data-fc-bg)!important}";
const css = PALETTE.map(block).concat(TAIL).join("");
fs.writeFileSync(__dirname + "/swish-new-compact.txt", css, "utf8");
console.log("bytes=" + css.length);
console.log("HEAD: " + css.slice(0, 110));
console.log("TAIL: " + css.slice(-110));
// Sanity: confirm every expected dark hex appears exactly once in the gradient base positions
for (const h of PALETTE) {
  const count = (css.split(h).length - 1);
  if (count !== 4) throw new Error("hex " + h + " appears " + count + " times (expected 4)");
}
console.log("SANITY OK: all 22 dark hexes appear exactly 4× each.");
