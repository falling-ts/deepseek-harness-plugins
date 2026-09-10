// Boot the `web` profile on a free port and call deepseekLlmApiExtensions.prepare()
// directly, catching the FULL error (including cause) that the session log never
// surfaces. Run: node --import tsx/esm D:/deepseek-harness-plugins/exploration/reqext-cause.ts
import { runProfile } from '../deepseek-harness/apps/cli/src/profile-boot.ts'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'

function causeChain(error: unknown): string[] {
  const chain: string[] = []
  let current: unknown = error
  let depth = 0
  while (current !== null && typeof current === 'object' && depth < 8) {
    const err = current as { message?: string; code?: string; cause?: unknown }
    chain.push(`${err.code ?? '-'} :: ${err.message ?? String(err)}`)
    current = err.cause
    depth++
  }
  return chain
}

const env = createLaunchEnvironmentSnapshot([
  { source: 'process', values: { ...process.env } },
])

console.log('[probe] booting web profile on port 3280 ...')
const { ctx, shutdown } = await runProfile({
  environment: env,
  profile: 'web',
  patchFiles: [],
  args: ['--port', '3280', '--no-open'],
})
console.log('[probe] booted. ctx.baseUrl =', ctx.baseUrl)

const extensions = ctx.get('deepseekLlmApiExtensions')
console.log('[probe] deepseekLlmApiExtensions:', extensions ? 'PRESENT' : 'ABSENT')

// Give preset trees a moment to settle (they mount lazily).
await new Promise(r => setTimeout(r, 2500))

const baseRequest = { body: { messages: [] }, signal: AbortSignal.timeout(30000) }
const variants: Array<{ label: string; request: typeof baseRequest }> = [
  { label: 'host tree only (no sessionId)', request: { ...baseRequest } },
  {
    label: 'host tree + default-preset tree (sessionId)',
    request: { ...baseRequest, sessionId: 'session-5c1ebb51-07cf-4eef-870c-b645d3f6f565' },
  },
]

for (const { label, request } of variants) {
  console.log(`\n=== prepare() :: ${label} ===`)
  try {
    const result = await extensions.prepare(request)
    const pkgField = (result.fields as Record<string, any>).dsh_plugin_packages
    console.log('SUCCEEDED. dsh_plugin_packages.packages =')
    console.log(JSON.stringify(pkgField?.packages ?? pkgField, null, 2))
  } catch (error) {
    console.log('FAILED. cause chain (outer -> inner):')
    for (const line of causeChain(error)) console.log('   ' + line)
  }
}

console.log('\n[probe] shutting down ...')
await shutdown()
process.exit(0)
