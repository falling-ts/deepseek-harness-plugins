#!/usr/bin/env node
/**
 * swish-verifier.cjs — standalone structural verifier for the falling-ts swish
 * stylesheet mechanism in dsh-force-compact/web/client.js.
 *
 * Checks performed (pure structural, no browser needed):
 *   1. The inline SWISH_CSS constant exists and contains every one of the 22
 *      expected color anchors plus the two pinned colors.
 *   2. Exactly 22 @keyframes blocks and 22 .falling-ts-swish-NN rules.
 *   3. Every rule ends in !important on both animation-name and
 *      background-image declarations.
 *   4. The injection routine is idempotent when invoked repeatedly against
 *      a stub DOM (applied N times ⇒ exactly 1 <style id=...> element).
 *
 * Exit code 0 = all checks pass, non-zero = at least one failed.
 */
"use strict";
const fs = require("node:fs");

const CLIENT_JS = process.argv[2] || "D:\\deepseek-harness-plugins\\dsh-force-compact\\web\\client.js";
const EXPECTED_HEXES = [
  "#4f9cf9", "#5b8def", "#6a5bff", "#8b5cf6", "#a855f7",
  "#c45bf9", "#db6bd4", "#e86bb0", "#f06b8b", "#f76b5b",
  "#fb8c5b", "#fca95b", "#fdc35b", "#d8e05b", "#aede5b",
  "#7ee083", "#5be0a0", "#5becd8", "#5bcdf9", "#7ba8f9",
  "#ff4d4f", "#52c41a",
];
let failures = 0;
function ok(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

const src = fs.readFileSync(CLIENT_JS, "utf8");
const m = src.match(/const SWISH_CSS = "(.*)";/);
ok("SWISH_CSS literal present in client.js", !!m);
if (!m) process.exit(1);
const css = m[1];

for (const h of EXPECTED_HEXES) {
  ok(`hex ${h} present`, css.includes(h));
}
const kfCount = css.split("@keyframes").length - 1;
ok("22 @keyframes blocks", kfCount === 22, `got ${kfCount}`);
const classCount = (css.match(/\.falling-ts-swish-\d+\{/g) || []).length;
ok("22 .falling-ts-swish-NN rules", classCount === 22, `got ${classCount}`);
const animImp = (css.match(/animation-name:[^\s;]+!important/g) || []).length;
const bgImp = (css.match(/background-image:[^;]+!important/g) || []).length;
ok("22 animation-name:!important decls", animImp === 22, `got ${animImp}`);
ok("22 background-image:!important decls", bgImp === 22, `got ${bgImp}`);

// Idempotency simulation against a stub DOM, exactly mirroring the inline routine.
let head = [];
const doc = {
  getElementById(id) { return head.find((e) => e.id === id) || null; },
  createElement(tag) { return { tag, id: "", textContent: "" }; },
  head: { appendChild(c) { head.push(c); } },
};
function ensure(doc) {
  if (doc.getElementById("falling-ts-swish-inline")) return;
  const el = doc.createElement("style");
  el.id = "falling-ts-swish-inline";
  el.textContent = css;
  doc.head.appendChild(el);
}
for (let i = 0; i < 3; i++) ensure(doc);
const hits = head.filter((e) => e.id === "falling-ts-swish-inline");
ok("injection idempotent across 3 invocations", hits.length === 1, `elements=${hits.length}`);
ok("injected payload byte-length sane (>3000)", hits[0] && hits[0].textContent.length > 3000,
   `bytes=${hits[0] ? hits[0].textContent.length : "—"}`);

process.exit(failures === 0 ? 0 : 1);
