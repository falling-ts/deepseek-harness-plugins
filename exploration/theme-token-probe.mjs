// Probe: does the settings chrome of both client halves follow the theme?
//
// The plugins are plain JS with inline styles, so they cannot write
// `color: var(--dsw-alias-*)` in a CSS Module the way upstream client packages
// do. They inject a token sheet instead and reference `var(--fcts-*)`, which
// keeps the light theme byte-identical to the previous literal values while the
// dark theme resolves to upstream semantic aliases.
//
// This probe does NOT just grep for `var(`. It parses the OFFICIAL theme sheet
// (packages/client/ui-theme/src/styles/design-platform.css), resolves every
// `--fcts-*` dark value through the upstream `var()` chain down to real sRGB
// numbers, and measures WCAG contrast against that theme's own background — so
// "the hints are white in dark mode" becomes a number, not an assertion of
// intent. It also rejects a dark value that names an upstream token which does
// not exist (a typo would silently fall back to nothing).
//
// Run: node exploration/theme-token-probe.mjs
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
let passed = 0
let failed = 0
const check = (ok, label, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${label}`) }
  else { failed++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

// ── the official theme sheet ─────────────────────────────────────────────────
const themeCss = read('deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css')
  .replace(/\/\*[\s\S]*?\*\//g, '')

/** Parse flat `selector{--a:b;--c:d}` blocks (the theme sheets contain nothing else). */
function parseBlocks(css) {
  const out = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(css))) {
    const decls = new Map()
    for (const decl of m[2].split(';')) {
      const at = decl.indexOf(':')
      if (at > 0) decls.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim())
    }
    out.push({ selector: m[1].trim(), decls })
  }
  return out
}

const lightScope = new Map()
const darkOverrides = new Map()
for (const block of parseBlocks(themeCss)) {
  const target = block.selector.includes('data-ds-dark-theme') ? darkOverrides : lightScope
  for (const [key, value] of block.decls) target.set(key, value)
}
// The dark block sits on the same element (body), so the light scope stays in
// scope for the static palette it references.
const darkScope = new Map([...lightScope, ...darkOverrides])

/** Parse `rgb()/rgba()/#hex` into {r,g,b,a}. */
function parseColor(raw) {
  const value = String(raw).trim()
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value)
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1]
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 }
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(value)
  if (fn) {
    const parts = fn[1].split(',').map((p) => Number(p.trim()))
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
  return null
}

/** Resolve a custom property to a concrete colour, following the var() chain. */
function resolveColor(name, scope, depth = 0) {
  if (depth > 12) return { error: `var() chain too deep at ${name}` }
  const raw = scope.get(name)
  if (raw === undefined) return { error: `undefined token ${name}` }
  const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(raw)
  if (ref) {
    const inner = resolveColor(ref[1], scope, depth + 1)
    if (!inner.error) return inner
    if (ref[2] !== undefined) {
      const fallback = parseColor(ref[2])
      if (fallback) return fallback
    }
    return inner
  }
  const parsed = parseColor(raw)
  return parsed ? { ...parsed, literal: raw } : { error: `unparsable value ${raw} for ${name}` }
}

/** Every --dsw-* name a declaration references. */
function referencedTokens(value) {
  return [...String(value).matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1])
}

const channel = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
/** Composite a possibly translucent colour over an opaque backdrop. */
const over = (fg, bg) => ({
  r: fg.a * fg.r + (1 - fg.a) * bg.r,
  g: fg.a * fg.g + (1 - fg.a) * bg.g,
  b: fg.a * fg.b + (1 - fg.a) * bg.b,
  a: 1,
})

const px = (c) => `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`

// ── the plugins' token sheets ────────────────────────────────────────────────
/** Lift the injected `const THEME_TOKENS_CSS = [ ... ].join("")` sheet. */
function extractTokenSheet(src, file) {
  const start = src.indexOf('const THEME_TOKENS_CSS = [')
  if (start < 0) return null
  const end = src.indexOf('].join("")', start)
  if (end < 0) return null
  return [...src.slice(start, end).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join('')
}

const plugins = [
  { name: 'dsh-force-compact', file: 'dsh-force-compact/web/client.js', settingsMarker: '// ── 视觉设计' },
  { name: 'dsh-web-ding', file: 'dsh-web-ding/web/client.js', settingsMarker: '// ── 设置分区 UI' },
]

const sheets = []
for (const plugin of plugins) {
  console.log(`\n=== ${plugin.name} ===`)
  const src = read(plugin.file)
  const sheet = extractTokenSheet(src, plugin.file)
  check(sheet !== null, 'injects a THEME_TOKENS_CSS sheet')
  if (sheet === null) continue
  sheets.push(sheet)

  const blocks = parseBlocks(sheet)
  const light = blocks.find((b) => b.selector === 'body')
  const dark = blocks.find((b) => b.selector.includes('data-ds-dark-theme'))
  check(light !== undefined, 'light branch declares the token values')
  check(dark !== undefined, 'dark branch (body[data-ds-dark-theme]) exists')
  if (!light || !dark) continue

  const lightKeys = [...light.decls.keys()]
  const darkKeys = [...dark.decls.keys()]
  const onlyLight = lightKeys.filter((k) => !darkKeys.includes(k))
  const onlyDark = darkKeys.filter((k) => !lightKeys.includes(k))
  check(onlyLight.length === 0 && onlyDark.length === 0,
    `both branches define the same ${lightKeys.length} tokens`,
    `onlyLight=[${onlyLight}] onlyDark=[${onlyDark}]`)
  check(lightKeys.every((k) => k.startsWith('--fcts-')), 'tokens use the workspace prefix')

  // Every dark value that names an upstream token must name a real one.
  const dangling = darkKeys.flatMap((k) => referencedTokens(dark.decls.get(k))
    .filter((t) => !darkScope.has(t)).map((t) => `${k} -> ${t}`))
  check(dangling.length === 0, 'every upstream token named in the dark branch exists', `[${dangling}]`)

  // The requirement, as a number: hint text is white (and legible) in dark mode.
  const darkBg = resolveColor('--dsw-alias-bg-base', darkScope)
  const darkHint = resolveColor(dark.decls.get('--fcts-text-hint').match(/var\(\s*(--[\w-]+)/)[1], darkScope)
  check(!darkHint.error, 'dark hint resolves through the upstream chain', darkHint.error || '')
  if (!darkHint.error) {
    check(darkHint.literal === '--dsw-alias-label-primary' || luminance(darkHint) >= 0.85,
      `dark hint is white (${px(darkHint)}, luminance ${luminance(darkHint).toFixed(3)})`)
    const ratio = contrast(darkHint, darkBg)
    check(ratio >= 7, `dark hint contrast vs ${px(darkBg)} is ${ratio.toFixed(2)}:1 (>= 7)`)
  }
  const darkMuted = darkScope.has(dark.decls.get('--fcts-text-muted').match(/var\(\s*(--[\w-]+)/)[1])
    ? resolveColor(dark.decls.get('--fcts-text-muted').match(/var\(\s*(--[\w-]+)/)[1], darkScope)
    : null
  check(darkMuted !== null && !darkMuted.error && contrast(darkMuted, darkBg) >= 4.5,
    `dark secondary text contrast is ${darkMuted && !darkMuted.error ? contrast(darkMuted, darkBg).toFixed(2) : 'n/a'}:1 (>= 4.5)`)

  // Light mode must keep the values the plugin shipped before the token layer.
  const EXPECTED_LIGHT = new Map([
    ['--fcts-text-hint', 'rgba(0,0,0,0.45)'],
    ['--fcts-text-muted', 'rgba(0,0,0,0.55)'],
    ['--fcts-text-body', 'rgba(0,0,0,0.65)'],
    ['--fcts-line', 'rgba(0,0,0,0.08)'],
    ['--fcts-line-soft', 'rgba(0,0,0,0.18)'],
    ['--fcts-line-strong', 'rgba(0,0,0,0.22)'],
    ['--fcts-fill-subtle', 'rgba(0,0,0,0.14)'],
    ['--fcts-fill-off', 'rgba(0,0,0,0.16)'],
    ['--fcts-fill-off-hover', 'rgba(0,0,0,0.24)'],
    ['--fcts-fill-hover', 'rgba(0,0,0,0.06)'],
  ])
  const drifted = [...EXPECTED_LIGHT].filter(([k, v]) => light.decls.get(k) !== v).map(([k]) => k)
  check(drifted.length === 0, 'light values are exactly the pre-token literals (no light-mode regression)',
    `[${drifted}]`)
  const lightBg = { r: 255, g: 255, b: 255, a: 1 }
  const lightHint = parseColor(light.decls.get('--fcts-text-hint'))
  check(contrast(over(lightHint, lightBg), lightBg) >= 3,
    `light hint contrast on white is ${contrast(over(lightHint, lightBg), lightBg).toFixed(2)}:1 (>= 3)`)

  // Every --fcts-* referenced in the component code must be declared.
  const used = [...new Set([...src.matchAll(/var\((--fcts-[\w-]+)/g)].map((m) => m[1]))]
  const undeclared = used.filter((k) => !lightKeys.includes(k))
  check(undeclared.length === 0, `all ${used.length} referenced --fcts-* tokens are declared`, `[${undeclared}]`)

  // Colour ownership: in the settings region only the brand palette and shadows
  // may stay literal; everything else must go through the tokens. The
  // notification surfaces of web-ding (toast, drawer) are deliberate white-glass
  // overlays and live BEFORE the settings marker.
  const marker = src.indexOf(plugin.settingsMarker)
  check(marker > 0, `settings region marker found (${plugin.settingsMarker})`)
  const region = src.slice(marker)
    .replace(/const THEME_TOKENS_CSS = \[[\s\S]*?\]\.join\(""\);/, '')  // the token sheet itself
    .replace(/\/\*[\s\S]*?\*\//g, '')                                  // comments
    .replace(/\/\/[^\n]*/g, '')
  const ALLOWED = [
    /^#2f6bff$/i, /^#3d8bff$/i, /^#3b74ff$/i,        // brand blue
    /^#ffffff$/i, /^#fff$/i,                          // knob / selected pill text
    /^rgba\(47,\s*107,\s*255,/,                       // brand glow
    /^rgba\(255,\s*255,\s*255,\s*0?\.12\)$/,          // ON-track inner highlight
    /^rgba\(0,\s*0,\s*0,\s*0?\.(06|08|12|3|35|4)\)$/, // knob / track shadows
  ]
  const literals = [...new Set([
    ...[...region.matchAll(/rgba?\([^)]*\)/g)].map((m) => m[0].replace(/\s+/g, ' ')),
    ...[...region.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]),
  ])]
  const stray = literals.filter((v) => !ALLOWED.some((re) => re.test(v)))
  check(stray.length === 0, 'settings chrome carries no literal colour outside the brand/shadow allowlist',
    `[${stray.join(' ')}]`)
}

check(sheets.length === 2 && sheets[0] === sheets[1],
  'both plugins inject an identical token sheet (shared --fcts- namespace)')

console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
