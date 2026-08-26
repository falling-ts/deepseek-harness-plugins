set -euo pipefail
REF_SHA=$(git -C "$1" rev-parse origin/main 2>/dev/null || echo origin/main)
CUR_SHA="HEAD"
REF_FILE=data/plugins/anzhaohao__dsh-side-chat-plus-plus.yml
CUR_FILE=data/plugins/falling-ts__dsh-force-compact.yml

measure () {
  local sha="$1"; local file="$2"
  local content; content="$(git -C "$1" show "${sha}:${file}" 2>/dev/null || true)"
  if [ -z "${content:-}" ]; then
    printf "  [%s %s] MISSING\n" "$sha" "$(basename "$file")"; return
  fi
  # Extract EN block (lines between 'en:' and next key)
  python3 - "$sha" "$file" <<PYEOF
import sys,re,subprocess
sha, file = sys.argv[1], sys.argv[2]
out=subprocess.run(['git','-C','.','show',f'{sha}:{file}'],capture_output=True,text=True).stdout
lines=out.splitlines()
buf=[]; ing=False
for ln in lines:
    t=ln.strip()
    if t.startswith('en:'):
        buf.append(re.sub(r'^en:\s*','',t)); ing=True; continue
    elif ing:
        if re.match(r'^\S+\s*:',t) and not t.startswith('-'):
            break
        if t: buf.append(t)
text=' '.join(x for x in buf if x).strip()
words=len([w for w in re.split(r'\s+',text) if w])
sent=max(1,len(re.findall(r'(?<=[.!?])(?:\s|$)',text)))
print(f"    EN words: {words}")
print(f"    EN chars: {len(text)}")
print(f"    EN sentences: {sent}  (avg {len(text)//sent} chars/sent)")
PYEOF
}

echo "===== REFERENCE ENTRY (already merged upstream) ====="
echo "  [origin/main $(basename $REF_FILE)]"
measure "origin/main" "$REF_FILE"
echo ""
echo "===== OUR ENTRY (about to be submitted) ====="
echo "  [HEAD $(basename $CUR_FILE)]"
measure "HEAD" "$CUR_FILE"
