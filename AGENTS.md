# AGENTS.md — dsh-s（根工作区）

本仓库是 **工作区容器**（workspace container）：不含业务源码，只跟踪子模块指针（gitlink）与工作区级文件。远程：`git@github.com:falling-ts/dsh-s.git`（branch `main`；原仓库名 `deepseek-harness-plugins` 已改名，GitHub 会重定向旧名）。

## 目录结构

| 路径 | 性质 | 远程 |
|------|------|------|
| `deepseek-harness/` | 子模块（上游 monorepo：`apps/cli`、`apps/web`、`packages/*`、`examples/*`，pnpm workspace） | `git@github.com:deepseek-ai/deepseek-harness.git`（branch `master`） |
| `dsh-force-compact/` | 子模块（独立 Cordis 插件 `@falling-ts/dsh-force-compact`，压缩会话历史） | `git@github.com:falling-ts/dsh-force-compact.git`（branch `main`） |
| `dsh-local-no-auth/` | 子模块（独立 Cordis 插件 `@falling-ts/dsh-local-no-auth`，loopback 免鉴权） | `git@github.com:falling-ts/dsh-local-no-auth.git`（branch `main`） |
| `dsh-web-ding/` | 子模块（独立 Cordis 插件 `@falling-ts/dsh-web-ding`，回合结束"叮"+toast） | `git@github.com:falling-ts/dsh-web-ding.git`（branch `main`） |
| `dsh-start-command/` | 子模块（独立 Cordis 插件 `@falling-ts/dsh-start-command`，回合开始执行命令） | `git@github.com:falling-ts/dsh-start-command.git`（branch `main`） |
| `dsh-chinese/` | 子模块（独立 Cordis 插件 `@falling-ts/dsh-chinese`，系统提示词注入中文规则） | `git@github.com:falling-ts/dsh-chinese.git`（branch `main`） |
| `awesome-dsh-plugin/` | 子模块（社区目录 fork：`data/plugins/*.yml` + 双语 README） | `git@github.com:falling-ts/awesome-dsh-plugin.git`（fork，branch `main`） |
| `docs/` | 工作区级技术文档（后端接口目录、会话结构、插件规范评审等） | — |
| `exploration/` | 各类验证/探测脚本（`.mjs`/`.cjs`，离线或真机复核实测结论） | — |
| `harness-server.sh` | 跨平台（Linux + Windows Git Bash）服务器启动脚本，默认 `127.0.0.1:3080` | — |
| `.idea/`、`.workbuddy/`、`.dsh-home/`、`*.log` | 已忽略（IDE 配置；会话本地笔记；工作区根残留 DSH_HOME；运行日志） | — |

## 子模块（指针）约定

- 子模块指针锁定**精确 commit**。子仓库内更新后须回根目录 `git add <子模块目录> && git commit` 移动指针；未移动前根仓库 `status` 显示子模块 modified。
- `.gitmodules` 的 `branch` 是该子模块的跟踪分支，可用 `git submodule update --remote` 沿分支前进。
- 新机器克隆：`git clone --recurse-submodules git@github.com:falling-ts/dsh-s.git`。
- 不要删除子模块内部 `.git`、不要吸收进根仓库、不要绕过子模块向上游（`deepseek-ai/*`）推送。

## Git 提交规范

自有项目（本仓库及其下所有插件仓库）提交必须三步组合：

    git add .
    git commit -m '<message>'
    git push

- **重点 `git add .`**：一次性暂存全部变更（含新文件、删除、子模块指针移动），不做挑选式部分暂存。
- 提交后**必须**推送到对应远程跟踪分支，不留本地未推送提交。

## 会话级授权（本工作区约定，长期生效）

- 用户在**本工作区**授予：开发过程**无需逐步请示**直接推进；多选一**默认采用推荐方案**并在结果标注所选；仅在不可逆/破坏性动作（推送、删除、改用户主目录数据）前简短说明。
- **文件沙箱策略：本会话 `danger-full-access`**（不受限读写）；审批弹窗已禁用——需审批的动作会被自动拒绝，因此**不要**发起 `sandbox_permissions` 升级，直接执行。
- **3080 是本工作区默认开发实例**，可随时 `bash harness-server.sh` 重启/停掉，不影响承载 GUI 的桌面应用（home `~/.dsh`，GUI 19387）。两个 home 互不串台的细节见 `dsh-s-server-run` 技能。

---

## 详细实战知识 → 拆分为技能（按需加载）

根 `AGENTS.md` 只保留导航；下述每类详细内容已外置成 dsh 技能（`skill` 工具可加载）。需要某类细节时，先调用对应技能，不要假定已内联。

| 主题 | 技能名 | 覆盖要点 |
|------|--------|----------|
| Windows 工具链 / npm 发布 | `dsh-s-windows-toolchain` | PowerShell 5.1 编码坑（禁 shell 改源码）、CJK 乱码、npm 显式 registry、202 异步发布三层判据 |
| pnpm 安装与构建 | `dsh-s-pnpm-build` | pnpm 11 链接空洞及修复脚本、批量删除保护 `CODEBUDDY_SAFE_DELETE_ENABLED=0`、前台起实例 |
| 起停 web 实例 / 两个 home / HMR | `dsh-s-server-run` | harness-server.sh 行为、摘 DSH_HOME、taskkill 失败判据、两个 home 写租约、profile HMR 热装载、client bundle rev、会话授权补充 |
| 插件集合约定 / 兼容性 / 规范评审 | `dsh-s-plugin-collection` | 独立插件目录结构、peer 下限基线（≥0.2.0-rc.1）、0.2.0 兼容缝、规范评审红线、主题 token |
| 桌面版装插件旧版 | `dsh-s-desktop-install` | pnpm 11 `minimumReleaseAge=1440` 闸门、精确版本/豁免解法、icon 要重启 |
| 会话级设置机制 | `dsh-s-per-session-settings` | `asVolatile` 覆盖字段、sessionId 取自 dock、display:contents 包装层、`useProjection`、几何 overlay |
| 系统提示词规则注入 | `dsh-s-chinese-plugin` | `ctx.systemPrompt.section` 三段规则、两个锚点、英文思考取证、实现要点 |
| 桌面操控 cua-driver | `dsh-s-computer-use` | 激活需 patch.yml insert、56 工具、WinUI3 拒 PostMessage、DPI 偏差 1.2577、像素 click 偏 |
| 后端接口 / wire 驱动 | `dsh-s-backend-api` | 四类通道、S1 句点 vs S4 斜杠、0.1.3 传输漂移、最小 create+prompt 序列、状态码/安全 |

另有文档级详述（不进技能）：官方插件规范符合性完整结论见 [docs/plugin-conformance-review.zh.md](docs/plugin-conformance-review.zh.md)；后端接口逐方法签名见 [docs/backend-api-catalogue.zh.md](docs/backend-api-catalogue.zh.md)。
