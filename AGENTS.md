# AGENTS.md — deepseek-harness-plugins（根工作区）

## 仓库性质

本仓库是**工作区容器**（workspace container）：不含业务源码，只跟踪
子模块指针（gitlink）与工作区级文件。远程：`git@github.com:falling-ts/deepseek-harness-plugins.git`（branch `main`）。

## 目录结构

| 路径 | 性质 | 远程 |
|------|------|------|
| `deepseek-harness/` | 子模块（上游 monorepo：`apps/cli`、`apps/web`、`packages/*`、`examples/*`，pnpm workspace） | `git@github.com:deepseek-ai/deepseek-harness.git`（branch `master`） |
| `dsh-compact/` | 子模块（独立 Cordis 插件 `@deepseek-ai/dsh-compact`，plain JS 无构建步骤） | `git@github.com:falling-ts/dsh-compact.git`（branch `main`） |
| `harness-server.sh` | 跨平台（Linux + Windows Git Bash）服务器启动脚本 | — |
| `.idea/`、`*.log` | 已忽略（IDE 配置；`harness-server.sh` 运行日志） | — |

## 子模块（指针）约定

- 子模块指针锁定**精确 commit**。子仓库内有更新或新提交后，须回到根目录
  `git add <子模块目录> && git commit` 移动指针；未移动指针前根仓库 `status` 会显示子模块 modified。
- `.gitmodules` 的 `branch` 是该子模块的跟踪分支，可用
  `git submodule update --remote` 沿分支前进。
- 新机器克隆：`git clone --recurse-submodules git@github.com:falling-ts/deepseek-harness-plugins.git`。
- 不要删除子模块内部的 `.git`，不要把子模块内容吸收进根仓库，
  也不要绕过子模块直接向子仓库的上游（`deepseek-ai/*`）推送。

## Git 提交规范

自有项目（本仓库及其下所有插件仓库）提交时必须按三步组合执行：

    git add .
    git commit -m '<message>'
    git push

- **重点 `git add .`**：一次性暂存全部变更（含新文件、删除、子模块指针移动），
  不做挑选式部分暂存——保证"工作区全部变更"进入同一个提交，
  避免残留文件漏提交或子模块指针忘记移动。
- 提交后**必须**推送到对应远程跟踪分支，不留本地未推送提交。

## 插件集合约定（适用于 `dsh-compact/` 及同级独立插件）

- 每个插件是**独立 git 仓库**（独立远程、独立 `package.json`），
  包名遵循 `@deepseek-ai/<插件名>` 命名空间。
- 插件最少包含：`index.js`（plain JavaScript，无构建步骤）、
  `cordis.yml`（opt-in overlay，挂载方式 `dsh web --patch <插件>/cordis.yml`）、
  `README.md` / `README.zh.md`、`LICENSE`。
- 插件是**纯 Host 监听器**：不引入 timer、内存态存储或 Client UI；
  各插件自身的规则见其 `AGENTS.md`（英文）。
- 各插件 `AGENTS.md` 中的 `../AGENTS.md`（collection conventions）指向本文件。
- 插件仓库内的 `CLAUDE.md` 固定只写一行 `@AGENTS.md`（引用本插件的 AGENTS.md），
  规则内容一律维护在 AGENTS.md，避免双写。

## harness-server.sh

- 用法：`bash harness-server.sh`（Linux 或 Windows Git Bash 均可）；
  环境变量覆盖：`PORT`（默认 `3080`）、`BIND_HOST`（默认 `127.0.0.1`）、`WAIT`（默认 `120` 秒）。
- 日志写入**脚本调用时的当前目录**：`dsh-web-<PORT>.log`（故根目录忽略 `*.log`）。
- 脚本第 1 步会杀掉端口占用进程：若当前 harness 自身占用该端口，
  运行脚本会导致承载本 GUI 的 harness 重启。
- `echo Y |` 前缀是修复 pnpm 交互式重装提示（`Proceed? (Y/n)`）：
  后台进程无 stdin 时会永久挂死在该提示上。
