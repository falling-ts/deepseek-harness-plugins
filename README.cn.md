# dsh-s

[English](README.md)

DeepSeek Harness 插件集的工作区容器（workspace container）。本仓库不含业务
源码：只跟踪独立项目仓库的**子模块指针（gitlink）**与工作区级文件。

## 目录结构

| 路径 | 性质 | 远程 |
|------|------|------|
| `deepseek-harness/` | 子模块——上游 monorepo（`apps/cli`、`apps/web`、`packages/*`、`examples/*`；pnpm workspaces） | `git@github.com:deepseek-ai/deepseek-harness.git`（branch `master`） |
| `dsh-force-compact/` | 子模块——独立 Cordis 插件 [`@falling-ts/dsh-force-compact`](dsh-force-compact/README.md)：每次 `session/flush` 时压缩会话历史（自有区间策略 + LLM 摘要器，持久变更委托给 `compaction` 服务） | `git@github.com:falling-ts/dsh-force-compact.git`（branch `main`） |
| `dsh-local-no-auth/` | 子模块——独立 Cordis 插件 [`@falling-ts/dsh-local-no-auth`](dsh-local-no-auth/README.md)：纯 Host；对回环绑定的实例免去浏览器会话认证（替换 `ctx.connection` 三个方法，非回环绑定即拒载） | `git@github.com:falling-ts/dsh-local-no-auth.git`（branch `main`） |
| `dsh-web-ding/` | 子模块——独立 Cordis 插件 [`@falling-ts/dsh-web-ding`](dsh-web-ding/README.md)：Host + 浏览器两半；回合结束时用 Web Audio 合成"叮"声并弹一个 Win11 风格通知 | `git@github.com:falling-ts/dsh-web-ding.git`（branch `main`） |
| `dsh-start-command/` | 子模块——独立 Cordis 插件 [`@falling-ts/dsh-start-command`](dsh-start-command/README.md)：Host + 浏览器两半；用户发话且无其他 agent 运行时，在 `agent/pre-step` 上于会话工作目录执行一条配置命令 | `git@github.com:falling-ts/dsh-start-command.git`（branch `main`） |
| `dsh-chinese/` | 子模块——独立 Cordis 插件 [`@falling-ts/dsh-chinese`](dsh-chinese/README.md)：纯 Host；为每次请求的系统提示词追加三条规则，每条以一句 `**…**` 加粗总纲开头（思考与临时输出用中文；编辑文件必须用编辑工具，命令与脚本只能用于检验；校验脚本优先内联执行，不留临时文件污染项目） | `git@github.com:falling-ts/dsh-chinese.git`（branch `main`） |
| `harness-server.sh` | 跨平台（Linux + Windows Git Bash）的 `pnpm dsh web` 启动脚本 | — |

## 快速开始

```sh
git clone --recurse-submodules git@github.com:falling-ts/dsh-s.git
cd dsh-s
bash harness-server.sh   # 在 127.0.0.1:3080 启动 harness web 服务器
```

`harness-server.sh` 说明：

- 环境变量覆盖：`PORT`（默认 `3080`）、`BIND_HOST`（默认 `127.0.0.1`）、
  `WAIT`（默认 `120` 秒）
- 日志写入**当前目录**：`dsh-web-<PORT>.log`
- 第 1 步杀掉端口占用进程——若当前 harness 占用该端口，则 GUI 会重启
- `echo Y |` 前缀自动应答 pnpm 的交互式重装提示，否则后台启动会永久挂死

## 子模块（指针）约定

- 指针锁定**精确 commit**。子仓库内有变更后，在根目录移动指针：
  `git add <子模块目录> && git commit`。
- `.gitmodules` 的 `branch` 条目支持 `git submodule update --remote`
  沿跟踪分支前进。
- 不要删除子模块的 `.git`、把子模块内容吸收进根仓库，或经由子模块向上游
  （`deepseek-ai/*`）推送。

## 仓库约定

完整约定见 [AGENTS.md](AGENTS.md)（`CLAUDE.md` 引用它）：子模块指针规则、
插件集合规则、git 提交规范（`git add .` + commit + push）。

## 许可证

[MIT](LICENSE)
