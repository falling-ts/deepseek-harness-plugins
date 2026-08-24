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
| `dsh-compact/` | Submodule — standalone Cordis plugin [`@deepseek-ai/dsh-compact`](dsh-compact/README.md): auto-compacts a session's history into a summary node at every `session/flush` | `git@github.com:falling-ts/dsh-compact.git` (branch `main`) |
| `harness-server.sh` | Cross-platform (Linux + Windows Git Bash) launcher for `pnpm dsh web` | — |

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
