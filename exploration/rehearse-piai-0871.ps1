# Rehearsal of the pi-ai 0.85.1 -> 0.87.1 bump in a throwaway git worktree.
# Touches nothing in the live checkout; the running 3080 host keeps its own node_modules.
# Usage: powershell -File exploration\rehearse-piai-0871.ps1
$ErrorActionPreference = 'Continue'
$src = 'D:\deepseek-harness-plugins\deepseek-harness'
$dst = Join-Path $env:TEMP 'dsh-piai-0871'
$bump = 'D:\deepseek-harness-plugins\exploration\rehearse-piai-0871-bump.mjs'

if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
git -C $src worktree prune
git -C $src worktree add --detach $dst HEAD
if ($LASTEXITCODE -ne 0) { git clone --shared --quiet $src $dst }
if (-not (Test-Path (Join-Path $dst 'package.json'))) { Write-Output 'FATAL: worktree not created'; exit 1 }

Set-Location $dst
Write-Output "[0] worktree HEAD: $(git log --oneline -1)"
Write-Output "[0] git status before edits: $((git status --short | Measure-Object -Line).Lines) lines"

node $bump $dst
if ($LASTEXITCODE -ne 0) { Write-Output 'FATAL: bump failed'; exit 1 }
Write-Output "[1] edits:"
git diff --stat | Select-Object -Last 6

Write-Output '[2] pnpm install --no-frozen-lockfile (mirror registry)'
pnpm install --no-frozen-lockfile
Write-Output "[2] install exit: $LASTEXITCODE"

Write-Output '[3] resolved pi-ai under llm-pi-ai'
node -e "const fs=require('fs');const p='packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/package.json';if(!fs.existsSync(p)){console.log('NOT LINKED');process.exit(0)}const j=JSON.parse(fs.readFileSync(p,'utf8'));console.log('version='+j.version)"

Write-Output '[4] patch actually applied to the installed dist? (expect: line removed)'
node -e "const fs=require('fs');const p='node_modules/.pnpm/'+fs.readdirSync('node_modules/.pnpm').find(d=>d.startsWith('@earendil-works+pi-ai@0.87'))+'/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js';const s=fs.readFileSync(p,'utf8');console.log('path='+p);console.log('has streaming parseStreamingJson assignment: '+/block\.arguments = parseStreamingJson\(block\.partialArgs\)/.test(s))"

Write-Output '[5] targeted typecheck: tsc -b packages/llm/llm-pi-ai'
pnpm exec tsc -b packages/llm/llm-pi-ai
Write-Output "[5] targeted typecheck exit: $LASTEXITCODE"

Write-Output '[6] focused tests: vitest run packages/llm/llm-pi-ai'
pnpm exec vitest run packages/llm/llm-pi-ai
Write-Output "[6] vitest exit: $LASTEXITCODE"

Write-Output '[7] opencode-go catalog actually served after the bump'
node --input-type=module -e "const a=await import('file:///'+process.cwd().replace(/\\\\/g,'/')+'/node_modules/.pnpm/'+(await import('node:fs')).readdirSync('node_modules/.pnpm').find(d=>d.startsWith('@earendil-works+pi-ai@0.87'))+'/node_modules/@earendil-works/pi-ai/dist/providers/all.js');const m=a.getBuiltinModels('opencode-go');console.log('opencode-go models: '+m.length);console.log('has deepseek-v4.1-flash: '+m.some(x=>x.id==='deepseek-v4.1-flash'))"

Write-Output '[done] rehearsal complete'
