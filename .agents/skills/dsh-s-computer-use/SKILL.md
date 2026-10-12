---
name: dsh-s-computer-use
description: Use when enabling or operating the dsh computer-use / cua-driver-native provider on Windows, or when drag/click/coordinates/screenshots behave wrong. Covers activation (patch.yml insert), tool catalog, and the Windows DPI / WinUI3 PostMessage pitfalls.
---

# 桌面操控（cua-driver-native）实测坑

profile `web` 已启用完整桌面操控：模型经 **Cua Driver 原生 SDK**（`@trycua/cua-driver@0.28.0`，Rust + 各平台原生二进制）观察并操作本机桌面。挂两个 entry：服务 `@deepseek-ai/dsh-computer-use`（独占注册）+ 提供方 `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native`。

## 关键坑：装得上，但激活不了

这两个包（连 MCP 变体）的 `package.json` **都没有 `dsh.bundle` 字段**，所以 `apps/cli/src/plugin.ts` 的 `reconcilePlugins` 只当普通依赖装、**不写进 `dsh.profile.bundles`**（只打印 "declares no dsh.bundle — installed as a plain dependency" 警告，退出码仍 0）。激活必须由 profile 自己的 `cordis.patch.yml` 用 `insert` 条目完成——官方 `snapshots/session/computer-use-cua-driver-native/cordis.yml` 同写法。两步：

    node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add \
      "@deepseek-ai/dsh-computer-use@0.1.6-alpha.1" \
      "@deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.1.6-alpha.1"
    # 再在 ~/.dsh/profiles/web/cordis.patch.yml 里 insert 上述两个 entry

profile 改完 patch 即进程内热重载，3080 无需重启（实测条目数 169→171，两条 `fiberPhase: active`，日志无新增启动行）。

## 验证方式

`POST /api/pluginInventory/list`，`payload.args` 传**空对象 `{}`**——该 `list()` 无参数（`packages/host/plugin-inventory/src/index.ts:66`），传 `_request` 会被 typert 拒（`gateway/arguments-invalid: unexpected "_request"`）。条目字段是 `entryId` / `moduleName` / `enabled` / `fiberPhase`（**不是** `name`/`id`/`status`）。

## 本机实测（Windows）

`check_permissions` 报进程完整性 High（RID 0x3000，已提权）、UIA 可用、PostMessage 注入可用；`health_report` 报 ax_capability（UIAutomation 可达）与 screen_capture_capability（D3D11 可达、Windows Graphics Capture 可用）全绿，三条 macOS 专属检查（bundle_identity / tcc_accessibility / tcc_screen_recording）在 Windows 上跳过——**Windows 不需要 macOS 那种录屏/辅助功能授权**。原生运行时加载即枚举出 **56 个工具**：`get_desktop_state`（全屏真实像素截图）、`get_window_state`（UIA 树 + 截图 + `element_token`）、`click` / `double_click` / `right_click` / `drag` / `scroll` / `type_text` / `press_key` / `hotkey` / `set_value`、`list_apps` / `list_windows` / `launch_app` / `invoke_menu` / `set_window_frame`、CDP `browser_*` 一族、`clipboard_read` / `clipboard_write`、轨迹录制回放（`start_recording` / `replay_trajectory`）；模型侧工具名带 `cua_driver_native__` 前缀。截图经 `attachment-local` 落成持久化附件再进模型。模型路由须声明图像输入：本机 `opencodego` 的 `deepseek-v4.1-flash` 是 `input: [text, image]`。

枚举工具目录与平台权限的探针（**不截图、不发输入、不请求授权**，可安全跑在活动桌面上）：`node exploration/cua-driver-tool-catalog.mjs [--permissions]`。

## 限制

一个组合只允许**一个**提供方注册，挂第二个（含同名实例）激活即失败；原生提供方与宿主**同进程**，原生崩溃会带走宿主进程；桌面不按 Session 预留，并发 Session 互相干扰，取消也无法回滚已投递的输入。

## 实操坑（用画图完整画一幅图时实测）

- **WinUI3/UWP 应用一律丢弃 PostMessage**：画图（mspaint）上 `drag` / `click` / `hotkey` / `press_key` 的默认 background 投递**全部无效**，但工具照样回 `✅ Posted`（`press_key` 诚实标 "not verified"）——"投递成功" ≠ "结果达成"，**判据只能是截图**。必须 `delivery_mode:"foreground"`（SendInput）。曾以为画了十几笔，其实整块画布一笔没上。
- **SendInput 落点有 DPI 缩放偏差**：本机（画面 2752×1152，driver 报 "@ 1x"，实际 125%）实测 **实际落点 = driver 报告坐标 × 1.2577**，故请求坐标须乘 **≈0.795** 才落到目标。`drag` 实测：请求 (795,374)→(914,183)，笔迹落在截图 (1000,470)→(1150,237)，两方向系数一致（1.2577 / 1.2545），偏移 ≈0。标定一次即可全程复用。
- **`click` 的像素换算与 `drag` 不一样**：`click(225,76)` 报告落点 `(701,101)`（≈×3.11），而 `drag(795,374)` 报告 `(1403,660)`（≈×1.765）。后果是**工具栏按钮用像素 click 必偏**（想点"椭圆"却点中"多边形"）。可靠替代：先 `zoom` 放大该区域定位，再用**短 `drag`**（from≈to）当点击。
- **`get_cursor_position` 不可用于校准**：`drag` 终点报 (1941,706) 时它返回 (1358,566)。
- **键盘快捷键**：画图里 **`P` = 铅笔**（可用；**`B` 是填充不是画笔**，误按会把整块画布填黑，用 Ctrl+Z 撤销）。Ctrl+Z / Ctrl+A / Delete 在 foreground 下均有效，但撤销是**逐段**的——画了 6 段要按 6 次。
- **本 harness 拿不到 `element_index`/`element_token`**：`get_window_state` 返回（markdown 渲染）里既无 `snapshot_id` 也无 token，README 推荐的"优先元素寻址"暂时走不通，只能退到像素 + 键盘。
- **Win32 通用对话框反而吃 PostMessage**：`另存为` 对话框里 `type_text` 走 PostMessage 成功，**中文文件名正常**（实测存成 `C:\Users\zghyu\Desktop\山水图.png`）。对话框默认停在上次保存目录，在文件名框直接输入**完整路径**即可换目录。

## 相关技能

- `dsh-s-backend-api`：pluginInventory/list 的 wire 形态与信封。
- `dsh-s-server-run`：patch 改动热重载、两个 home。
