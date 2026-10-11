# deepseek-harness-plugins

[中文](README.cn.md)

Workspace container for the DeepSeek Harness plugin collection. This
repository holds no business source code: it tracks **submodule pointers
(gitlinks)** for the independent project repositories plus workspace-level
files.

## Layout

| Path | Kind | Remote |
|------|------|--------|
| `deepseek-harness/` | Submodule — upstream monorepo (`apps/cli`, `apps/web`, `packages/*`, `examples/*`; pnpm workspaces) | `git@github.com:deepseek-ai/deepseek-harness.git` (branch `master`) |
| `dsh-force-compact/` | Submodule — standalone Cordis plugin [`@falling-ts/dsh-force-compact`](dsh-force-compact/README.md): compacts a session's history at every `session/flush` (own region policy + LLM summarizer, durable mutation delegated to the `compaction` service) | `git@github.com:falling-ts/dsh-force-compact.git` (branch `main`) |
| `dsh-local-no-auth/` | Submodule — standalone Cordis plugin [`@falling-ts/dsh-local-no-auth`](dsh-local-no-auth/README.md): host-only, bypasses browser-session auth for a loopback-bound instance by replacing three `ctx.connection` methods (refuses to start on a non-loopback bind) | `git@github.com:falling-ts/dsh-local-no-auth.git` (branch `main`) |
| `dsh-web-ding/` | Submodule — standalone Cordis plugin [`@falling-ts/dsh-web-ding`](dsh-web-ding/README.md): host + browser halves; a Web Audio "ding" and a Windows 11-style toast when a turn ends | `git@github.com:falling-ts/dsh-web-ding.git` (branch `main`) |
| `dsh-start-command/` | Submodule — standalone Cordis plugin [`@falling-ts/dsh-start-command`](dsh-start-command/README.md): host + browser halves; runs one configured command in the session cwd on `agent/pre-step` when the user submits a prompt and no other agent is running | `git@github.com:falling-ts/dsh-start-command.git` (branch `main`) |
| `dsh-chinese/` | Submodule — standalone Cordis plugin [`@falling-ts/dsh-chinese`](dsh-chinese/README.md): host-only; appends two standing rules to every request's system prompt (think and write in Chinese, and edit files with the editing tools while commands and scripts only verify) | `git@github.com:falling-ts/dsh-chinese.git` (branch `main`) |
| `awesome-dsh-plugin/` | Submodule — community catalog (`data/plugins/*.yml` entries + regenerated bilingual READMEs) | `git@github.com:falling-ts/awesome-dsh-plugin.git` (fork, branch `main`) |
| `harness-server.sh` | Cross-platform (Linux + Windows Git Bash) launcher for `pnpm dsh web` on `127.0.0.1:3080` — the workspace's default development instance | — |

## Getting started

```sh
git clone --recurse-submodules git@github.com:falling-ts/deepseek-harness-plugins.git
cd deepseek-harness-plugins
bash harness-server.sh   # start the harness web server on 127.0.0.1:3080
```

`harness-server.sh` details:

- Env overrides: `PORT` (default `3080`), `BIND_HOST` (default `127.0.0.1`),
  `WAIT` (default `120`s)
- Writes the log to the **current directory** as `dsh-web-<PORT>.log`
- Step 1 kills whatever listens on the port — if the current harness holds
  it, the GUI restarts
- The `echo Y |` prefix auto-answers pnpm's interactive reinstall prompt,
  which would otherwise hang a background start forever

## Submodule (pointer) conventions

- Pointers pin **exact commits**. After changes in a sub-repo, move the
  pointer from the root: `git add <submodule-dir> && git commit`.
- The `branch` entries in `.gitmodules` allow
  `git submodule update --remote` to follow the tracked branch.
- Do not delete a submodule's `.git`, absorb its content into the root
  repository, or push to the upstream (`deepseek-ai/*`) through the submodule.

## Repository conventions

See [AGENTS.md](AGENTS.md) (referenced by `CLAUDE.md`) for the full
conventions: submodule pointer rules, plugin collection rules, and the git
commit convention (`git add .` + commit + push).

## License

[MIT](LICENSE)
