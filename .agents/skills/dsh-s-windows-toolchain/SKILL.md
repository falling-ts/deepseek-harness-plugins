---
name: dsh-s-windows-toolchain
description: Use when editing source files via shell, reading CJK output, using PowerShell in this workspace, or publishing npm packages from this machine. Covers PowerShell 5.1 encoding traps and npm publish registry pitfalls observed on the dsh-s Windows host.
---

# Windows 工具链与 npm 发布（dsh-s 实测坑）

本机命令解释器是 **Windows PowerShell 5.1**（NonInteractive）。改文件一律用 `edit`/`write` 文件工具，**绝不用 shell 字符串 cmdlet 往返改写源码**。改完用 `node -e "JSON.parse(fs.readFileSync(...))"` 严格校验。

## PowerShell 5.1 四条规矩

- **禁止 shell 改写源码**：`Get-Content -Raw` + `-replace` + `Set-Content` 会按 ANSI 解码 UTF-8（无 BOM）文件，把多字节字符截断成非法 UTF-8。代价：JSON 仍"看起来正常"、PowerShell `ConvertFrom-Json` 也能过，但 Node `JSON.parse` 直接拒绝 → 插件整包 `failed to import`、宿主半部不加载（症状是 `settings/describe` 少一个命名空间，而非启动报错）。判据用 Node 的严格 `JSON.parse`，别信 `ConvertFrom-Json`。
- **CJK 输出到 stdout 会乱码**：判断内容看文件本身（`read`/`grep`），不要靠 shell 回显。
- **不支持 `??`** 空合并运算符；`$host` 是保留变量，勿占用。
- **`Invoke-WebRequest` 在 NonInteractive 下需 `-UseBasicParsing`**（否则 "Read and Prompt functionality is not available"）；`Invoke-RestMethod` 取 HTML/JS 文本可用。取 3080 的 client bundle：`Invoke-RestMethod "http://127.0.0.1:3080/plugins/??<包名>/client.js&rev=<哈希>"`——URL 的 `rev` 参数不能省（省了 404；哈希从 `GET /` 模块表取）。

## npm 发布（2026-09-17 实测）

- **必须显式 `--registry=https://registry.npmjs.org/`**：本机 `~/.npmrc` 把默认 registry 指向 `registry.npmmirror.com` 镜像，而 `_authToken` 只作用域在 `//registry.npmjs.org/`。不显式指定时 `npm whoami` 报 `ENEEDAUTH`（像没登录，其实凭据有效）。发布命令一律写 `npm publish --registry=https://registry.npmjs.org/`（`publishConfig.access: public` 已在各插件 `package.json`，无需再加 `--access`）。
- **`PUT` 返回 202 ≠ 立刻可取**：同日发三个包时两个回 200、一个回 202（已接受、异步提交）。该版本元数据先落地（版本级端点 200、packument 的 `dist-tags.latest` 随后更新），**tarball 的 CDN 对象还要再等一会儿才可下载**。复验分清三层：① `https://registry.npmjs.org/<pkg>/<ver>`（版本级端点，不受 packument 缓存影响，最快的决定性判据）；② packument 的 `dist-tags.latest`；③ tarball URL 本身（可能最后才通）。`npm view <pkg> versions` 看不到新版本先怀疑传播/缓存，别急着重复发布（重复发布同版本会 `EPUBLISHCONFLICT`）；用 ① 判定真伪。

## 相关技能

- `dsh-s-pnpm-build`：pnpm 链接空洞、本机删除保护、起实例验证。
- `dsh-s-server-run`：harness-server.sh、两个 home、HMR 与重启。
