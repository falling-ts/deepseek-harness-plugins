// Syntax-check the plugin's edited modules by dynamically importing each.
// Plain parse + load probe: a SyntaxError at load time fails fast.
const dir = 'D:/deepseek-harness-plugins/dsh-force-compact'
const files = [
  'index.js',
  'src/engine/summarizer.js',
  'src/engine/builtin.js',
  'src/engine/backend.js',
  'src/engine/region.js',
  'src/engine/checkpoint.js',
  'src/core/settings.js',
  'src/core/policy.js',
  'src/hooks/guard.js',
  'src/hooks/command.js',
  'src/hooks/idle.js',
  'src/hooks/wire-rewrite.js',
]
for (const f of files) {
  const url = 'file:///' + (dir + '/' + f).split('/').map(s => s.replace(/\\/g, '/')).join('/')
  try {
    await import(url)
    console.log('PARSE_OK', f)
  } catch (e) {
    console.log('FAIL', f, '->', e.constructor.name, ':', e.message.split('\n')[0])
    process.exitCode = 1
  }
}
