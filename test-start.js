#!/usr/bin/env node
/**
 * test-start.js —— dsh-start-command 的「开始前命令」冒烟脚本。
 *
 * 作用:每当你主动发一条对话、且当时没有别的 agent 在跑,就在桌面上**弹一个看得见的
 * 提示**,证明「开始前命令」真的在模型请求之前跑过了。
 *
 * 默认动作(**2026-09-30 晚改定**):在屏幕右下角**新弹一个自绘窗口**(popup 模式)——
 * 每一次执行都新开一个,不合并、不替换、不受系统通知策略影响,窗口上写着
 * `Harness 开始了。` + `第 N 次` + 时刻,叠着往上排,默认 9 秒后自动淡出(点一下立即关)。
 *
 * 为什么默认不再是记事本:记事本走的是「同一份文档只保留一个窗口」的复用语义,
 * 手动连着跑第二遍时屏幕上**什么都不会发生**(只是把已有窗口拉到前台;若它本来就在
 * 前台,则完全看不出区别)。要「每次执行都确定看得见」,就得每次都新建窗口。
 *
 * 五种动作:`--popup`(默认)/ `--notepad` / `--notify` / `--toast` / `--card`
 *   1. **右下角弹窗**(默认,`--popup`):自绘 Win11 风格卡片,一次执行一个窗口。
 *      计数器落在 `%TEMP%\harness-popup-count.txt`,窗口第二行显示 `第 N 次`,所以
 *      连点两次就是两个叠起来的窗口、编号连续——**这就是「命令确实执行了」的直接判据**。
 *      默认 9 秒自动淡出(`--duration=` 改),`--sticky` 改成不自动关(必须点掉),
 *      `--silent` 关掉提示音,`--focus` 连前台焦点一起抢(默认只置顶,不抢焦点)。
 *   2. **记事本**(`--notepad`):把一行文字写进 `%TEMP%\harness-started.txt` 再用
 *      `notepad.exe` 打开;已有一个开着同一份文档的窗口时**只聚焦不叠窗口**
 *      (`--new` 可强制新开)。适合"留一份文字证据在屏幕上",不适合当提醒。
 *   3. **真·Windows 通知**(`--notify` 自动 / `--toast` 强制,WinRT
 *      `ToastNotificationManager`)——右下角 toast,同时在通知中心留一条。
 *      ⚠️ 这条路**不保证弹得出来**:要不要显示由系统通知平台说了算(专注助手/通知设置
 *      都能压掉),提权进程发出的通知在老版本 Windows 上还有被静默丢弃的已知问题;
 *      而且 Tag/Group 固定,连着发是**替换**上一条而不是堆叠。要"无限次、确定看得见"
 *      就用默认的 popup。
 *   4. **自绘卡片**(`--card`):popup 的旧外观(6 秒、固定右下角位置、不叠放)。
 *
 * 四个必须在实现里解决的问题:
 *   - **中文不能走命令行参数**:`powershell -Command "…中文…"` 会被控制台代码页
 *     按 ANSI 解码,「开始前执行成功」在脚本里就变成乱码。弹窗/通知路径一律用
 *     `-EncodedCommand`(UTF-16LE + base64)传脚本;记事本路径更彻底——**正文由 Node
 *     直接以 UTF-8 写进文件**,PowerShell 只拿一条纯 ASCII 的路径去启动记事本。
 *   - **不能阻塞「开始前命令」**:动作进程 `detached` 起、父进程立即退出,所以它绝不会
 *     把这一回合卡住。(`--wait` 是排障用的前台例外,弹窗模式下会等到窗口关闭。)
 *   - **`SetForegroundWindow` 在后台/提权进程里会被前台锁挡掉**:所以抢焦点要走
 *     `AttachThreadInput` → 松一次 Alt → `SwitchToThisWindow` 三级连锁(见 `--focus`),
 *     而"看得见"这件事本身靠 `TopMost`,不依赖抢焦点成功。
 *   - **提醒必须不依赖任何持久状态**:计数器只是个自增文本,丢了就从 1 重来,
 *     不影响"每次都弹一个新窗口"这个事实。
 *
 * 用法:
 *   node test-start.js                        # 右下角弹一个「Harness 开始了。」(第 N 次)
 *   node test-start.js "自定义内容"            # 位置参数 = 弹窗大字(记事本模式下是正文)
 *   node test-start.js --text="自定义内容"     # 同上,显式写法
 *   node test-start.js --sticky               # 不自动关,必须点掉
 *   node test-start.js --duration=3000        # 停留毫秒(默认 9000)
 *   node test-start.js --silent               # 不播提示音
 *   node test-start.js --focus                # 连前台焦点一起抢(默认只置顶)
 *   node test-start.js --no-launch            # 只写标记不弹窗(自动化用)
 *   node test-start.js --notepad              # 改回记事本(复用已有窗口)
 *   node test-start.js --notepad --new        # 记事本强制新开窗口
 *   node test-start.js --toast                # 改弹系统通知(可能被系统静音/替换)
 *   node test-start.js --card                 # 改弹旧版自绘卡片
 *   node test-start.js --wait                 # 前台等待并打印实际走的那条路(排障用)
 *
 * 每次运行还会覆盖写一份时间戳标记(`%TEMP%\dsh-start-command-last-run.txt`)——
 * 动作是给人看的,标记是给自动化看的:想验证「开始前命令有没有执行」读它的 mtime 即可,
 * 不必盯屏幕;`--no-launch` 下它是唯一的证据。写失败(只读沙箱)不影响动作本身。
 *
 * 退出码:0 = 已把动作投出去(或非 Windows 上明确跳过);1 = 参数错。
 *
 * @file 工作区根的独立测试脚本(不属于任何插件源码,不参与插件加载)
 */
'use strict';

const { spawn } = require('node:child_process');
const { readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join } = require('node:path');

const IS_WINDOWS = process.platform === 'win32';

/**
 * 每次运行覆盖写的时间戳文件。动作是给人看的,这个文件是给自动化看的:
 * 「开始前命令到底有没有执行、什么时候执行的」不必靠肉眼盯屏幕,读它的 mtime 即可。
 * 写失败(例如会话沙箱是只读)不影响动作,静默忽略。
 */
const MARKER = join(tmpdir(), 'dsh-start-command-last-run.txt');

/**
 * popup 模式的执行计数器。空或读不出来就从 1 开始——它只是给窗口上那句
 * 「第 N 次」用的,丢了不影响"每次都新弹一个窗口"这个事实。
 */
const COUNT_FILE = join(tmpdir(), 'harness-popup-count.txt');

/**
 * 「子进程真的起来了」信号。PowerShell 侧脚本的第一条语句就是刷新它。
 *
 * 为什么需要:在受限的 shell(实测:本会话的工具 shell)里,`spawn(…, { detached: true })`
 * 出来的 PowerShell **会立刻以 0 退出、什么都不做**——不报错、不留痕,于是"命令跑了"
 * 变成一句谎话。有了这条信号,Node 侧就能在 2.5 秒内判定"这次投递没落地",并改用
 * 非 detached 的方式**重投一次**;而只要子进程还活着(只是慢),就绝不会重复投递。
 */
const SIGNAL_FILE = join(tmpdir(), 'dsh-start-command-child.txt');

/**
 * 记事本模式写入并打开的文档。**路径保持纯 ASCII**——中文只活在文件内容里,
 * 于是命令行、控制台代码页、PowerShell 的 `-EncodedCommand` 都不参与中文传递。
 */
const DEFAULT_DOC = join(tmpdir(), 'harness-started.txt');

/** 「Windows PowerShell」在开始菜单里的 AppUserModelID —— 系统自带,故 toast 无需注册应用。 */
const PS_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/** 窗口/通知里显示的来源名(第一行小字)。 */
const APP_NAME = 'dsh-start-command';

const DEFAULT_TITLE = '开始前执行成功';
const DEFAULT_BODY = '开始前命令已在模型请求前执行';
const DEFAULT_TEXT = 'Harness 开始了。';
const DEFAULT_DWELL_MS = 9000;

/** 叠放窗口的槽位数:编号对槽位取模,所以旧窗口早关掉之后槽位会自然回收。 */
const POPUP_SLOTS = 6;

/** toast XML 里必须转义的字符;顺带把 `'` 也转掉,省得在 PowerShell 单引号串里再处理。 */
function xmlEscape(text) {
  return String(text).replace(/[<>&'"]/g, (ch) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  }[ch]));
}

/** 包成 PowerShell 单引号字面量(单引号自身翻倍)。 */
function psLiteral(text) {
  return "'" + String(text).replace(/'/g, "''") + "'";
}

/**
 * 每个 PowerShell 侧脚本开头的「我起来了」信号(纯 ASCII)。
 * 见 {@link SIGNAL_FILE} 的说明:它是 Node 侧判定"这次投递有没有落地"的唯一依据。
 */
function psSignalSnippet(mode) {
  return `
# 第一条语句就上报"我起来了":Node 侧靠它判定 detached 投递是否静默失败。
try { Set-Content -LiteralPath ${psLiteral(SIGNAL_FILE)} -Value (${psLiteral(mode)} + ' ' + $PID) -Encoding ascii } catch { }
`;
}

function parseArgs(argv) {
  const opts = {
    mode: 'popup',        // popup | notepad | notify | toast | card
    text: DEFAULT_TEXT,
    textSet: false,
    doc: DEFAULT_DOC,
    launch: true,
    forceNew: false,
    title: DEFAULT_TITLE,
    body: DEFAULT_BODY,
    titleSet: false,
    bodySet: false,
    silent: false,
    sticky: false,
    focus: false,
    wait: false,
    dwellMs: DEFAULT_DWELL_MS,
    help: false,
  };
  const positional = [];
  for (const raw of argv) {
    const arg = String(raw);
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--popup') { opts.mode = 'popup'; continue; }
    if (arg === '--notepad') { opts.mode = 'notepad'; continue; }
    if (arg === '--notify') { opts.mode = 'notify'; continue; }
    if (arg === '--card') { opts.mode = 'card'; continue; }
    if (arg === '--toast') { opts.mode = 'toast'; continue; }
    if (arg === '--silent' || arg === '-s') { opts.silent = true; continue; }
    if (arg === '--sticky') { opts.sticky = true; continue; }
    if (arg === '--focus') { opts.focus = true; continue; }
    if (arg === '--wait' || arg === '-w') { opts.wait = true; continue; }
    if (arg === '--new') { opts.forceNew = true; continue; }
    if (arg === '--no-launch') { opts.launch = false; continue; }
    if (arg.startsWith('--text=')) { opts.text = arg.slice('--text='.length); opts.textSet = true; continue; }
    if (arg.startsWith('--file=')) { opts.doc = arg.slice('--file='.length); continue; }
    if (arg.startsWith('--title=')) { opts.title = arg.slice('--title='.length); opts.titleSet = true; continue; }
    if (arg.startsWith('--body=')) { opts.body = arg.slice('--body='.length); opts.bodySet = true; continue; }
    if (arg.startsWith('--duration=')) {
      const ms = Number.parseInt(arg.slice('--duration='.length), 10);
      if (!Number.isFinite(ms) || ms < 500) throw new Error('--duration 需要 >= 500 的毫秒数');
      opts.dwellMs = ms;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`未知参数: ${arg}`);
    positional.push(arg);
  }
  // 位置参数 = **当前模式的主要内容**:弹窗/记事本模式是那行大字,通知模式是标题(其后是正文)。
  // 显式 `--text=` / `--title=` / `--body=` 优先,位置参数只做补充。
  if (positional.length > 0) {
    if (opts.mode === 'notepad' || opts.mode === 'popup') {
      if (!opts.textSet) opts.text = positional.join(' ');
    } else {
      if (!opts.titleSet) opts.title = positional[0];
      if (!opts.bodySet && positional.length > 1) opts.body = positional.slice(1).join(' ');
    }
  }
  return opts;
}

/** 组装 toast 载荷:`<audio silent="true"/>` 只在静音时出现,否则用系统默认提示音。 */
function buildToastXml(title, body, silent) {
  return [
    '<toast duration="short">',
    '  <visual>',
    '    <binding template="ToastGeneric">',
    `      <text>${xmlEscape(title)}</text>`,
    `      <text>${xmlEscape(body)}</text>`,
    '    </binding>',
    '  </visual>',
    `  <audio${silent ? ' silent="true"' : ' src="ms-winsoundevent:Notification.Default"'}/>`,
    '</toast>',
  ].join('\n');
}

/**
 * 记事本模式的 PowerShell 侧脚本:**只出现 ASCII**(文档路径 + 逻辑),中文一个都没有。
 * 做三件事:① 已经开着同一份文档就复用它的窗口;② 否则用文件路径启动 `notepad.exe`;
 * ③ 轮询到窗口句柄后抢前台,并把 `reused / found / focused` 三个判据打到 stdout。
 */
function buildNotepadScript(opts) {
  return `
$ErrorActionPreference = 'Stop'
# 不写进度流:否则 PowerShell 会把「Preparing modules for first use.」以 CLIXML 形式
# 打到 stderr,而「开始前命令」的 stderr 尾巴是会被宿主写进日志的,白白像一条报错。
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
${psSignalSnippet('notepad')}
# 抢前台要用的入口:后台进程自己 SetForegroundWindow 会被前台锁挡掉,三级连锁都试一遍
# (① Attach 到当前前台线程再调;② 松一次 Alt 键解锁后再调;③ 走 SwitchToThisWindow)。
# 实测(2026-09-30):宿主(提权 + 后台)执行本命令时,只有 ②/③ 能真的把窗口拉到最前。
Add-Type -Namespace Dsh -Name Fg -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr h, int c); [DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, System.IntPtr p); [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f); [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId(); [DllImport("user32.dll")] public static extern void SwitchToThisWindow(System.IntPtr h, bool f); [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);'

function Focus-DshWindow([System.IntPtr]$h) {
  if ($h -eq [System.IntPtr]::Zero) { return $false }
  [void][Dsh.Fg]::ShowWindowAsync($h, 9)
  if ([Dsh.Fg]::GetForegroundWindow() -eq $h) { return $true }
  $fg  = [Dsh.Fg]::GetForegroundWindow()
  $tid = [Dsh.Fg]::GetWindowThreadProcessId($fg, [System.IntPtr]::Zero)
  $me  = [Dsh.Fg]::GetCurrentThreadId()
  try {
    if ($tid -ne 0 -and $tid -ne $me) { [void][Dsh.Fg]::AttachThreadInput($tid, $me, $true) }
    [void][Dsh.Fg]::SetForegroundWindow($h)
    if ($tid -ne 0 -and $tid -ne $me) { [void][Dsh.Fg]::AttachThreadInput($tid, $me, $false) }
  } catch { }
  if ([Dsh.Fg]::GetForegroundWindow() -ne $h) {
    # 前台锁:一次 Alt 按下/抬起会被前台锁认作"用户刚操作过",随后的强拉才被放行。
    try {
      [Dsh.Fg]::keybd_event(18, 0, 0, [System.UIntPtr]::Zero)
      [Dsh.Fg]::keybd_event(18, 0, 2, [System.UIntPtr]::Zero)
      [void][Dsh.Fg]::SetForegroundWindow($h)
    } catch { }
  }
  if ([Dsh.Fg]::GetForegroundWindow() -ne $h) {
    try { [Dsh.Fg]::SwitchToThisWindow($h, $true) } catch { }
    Start-Sleep -Milliseconds 200
  }
  return ([Dsh.Fg]::GetForegroundWindow() -eq $h)
}

$file  = ${psLiteral(opts.doc)}
$leaf  = ${psLiteral(basename(opts.doc))}
$force = ${opts.forceNew ? '$true' : '$false'}

# 认窗口认的是**标题里含这份文档名**:Win11 记事本是单实例多标签,标题跟着当前标签走。
function Get-DshNotepad {
  Get-Process -Name notepad -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and $_.MainWindowTitle.Contains($leaf) } |
    Select-Object -First 1
}

$reused   = $false
$launched = $null
$target   = $null
if (-not $force) {
  $target = Get-DshNotepad
  if ($target) { $reused = $true }
}
if (-not $target) {
  try {
    $launched = Start-Process -FilePath 'notepad.exe' -ArgumentList ('"' + $file + '"') -PassThru
  } catch {
    Write-Output ('kind=notepad launch-failed: ' + $_.Exception.Message)
    exit 3
  }
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 100
    $target = Get-DshNotepad
    if ($target) { break }
  }
  # 标签已开但没抢到标题(标题仍指向别的标签)时,退回到我们自己拉起的那个进程。
  if (-not $target -and $launched -and -not $launched.HasExited -and $launched.MainWindowHandle -ne 0) {
    $target = $launched
  }
}

$focused = $false
if ($target) {
  $target.Refresh()
  $focused = Focus-DshWindow $target.MainWindowHandle
}

Write-Output ('kind=notepad reused=' + $reused + ' found=' + [bool]$target + ' focused=' + $focused)
exit 0
`;
}

/** 抢焦点那段(user32 入口 + Focus-DshWindow)在弹窗脚本里也要用,抽出来复用。 */
function focusHelperScript() {
  return `
Add-Type -Namespace Dsh -Name Fg -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr h, int c); [DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, System.IntPtr p); [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f); [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId(); [DllImport("user32.dll")] public static extern void SwitchToThisWindow(System.IntPtr h, bool f); [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);'

function Focus-DshWindow([System.IntPtr]$h) {
  if ($h -eq [System.IntPtr]::Zero) { return $false }
  [void][Dsh.Fg]::ShowWindowAsync($h, 9)
  if ([Dsh.Fg]::GetForegroundWindow() -eq $h) { return $true }
  $fg  = [Dsh.Fg]::GetForegroundWindow()
  $tid = [Dsh.Fg]::GetWindowThreadProcessId($fg, [System.IntPtr]::Zero)
  $me  = [Dsh.Fg]::GetCurrentThreadId()
  try {
    if ($tid -ne 0 -and $tid -ne $me) { [void][Dsh.Fg]::AttachThreadInput($tid, $me, $true) }
    [void][Dsh.Fg]::SetForegroundWindow($h)
    if ($tid -ne 0 -and $tid -ne $me) { [void][Dsh.Fg]::AttachThreadInput($tid, $me, $false) }
  } catch { }
  if ([Dsh.Fg]::GetForegroundWindow() -ne $h) {
    try {
      [Dsh.Fg]::keybd_event(18, 0, 0, [System.UIntPtr]::Zero)
      [Dsh.Fg]::keybd_event(18, 0, 2, [System.UIntPtr]::Zero)
      [void][Dsh.Fg]::SetForegroundWindow($h)
    } catch { }
  }
  if ([Dsh.Fg]::GetForegroundWindow() -ne $h) {
    try { [Dsh.Fg]::SwitchToThisWindow($h, $true) } catch { }
    Start-Sleep -Milliseconds 150
  }
  return ([Dsh.Fg]::GetForegroundWindow() -eq $h)
}
`;
}

/**
 * 通知模式的 PowerShell 侧脚本。全部中文都在这里烘焙进字符串,再由 {@link encodeCommand}
 * 以 UTF-16LE 编码送出 —— 这条路径与命令行代码页无关。
 */
function buildNotificationScript(opts) {
  const toastXml = buildToastXml(opts.title, opts.body, opts.silent);
  return `
$ErrorActionPreference = 'Stop'
# 不写进度流:否则 PowerShell 会把「Preparing modules for first use.」以 CLIXML 形式
# 打到 stderr,而「开始前命令」的 stderr 尾巴是会被宿主写进日志的,白白像一条报错。
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
${psSignalSnippet(opts.mode)}
$app      = ${psLiteral(APP_NAME)}
$title    = ${psLiteral(opts.title)}
$body     = ${psLiteral(opts.body)}
$aumid    = ${psLiteral(PS_AUMID)}
$toastXml = ${psLiteral(toastXml)}
$mode     = ${psLiteral(opts.mode)}
$dwellMs  = ${Number(opts.dwellMs)}

# ── 1) 真·Windows 通知 ──────────────────────────────────────────────────────
function Show-DshToast {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($toastXml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  # 固定 Tag/Group:同一条通知会被替换而不是无限堆叠(开始前命令每条对话都会跑)。
  $toast.Tag = 'dsh-start-command'
  $toast.Group = 'dsh-start-command'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
}

$wantCard = ($mode -eq 'card')
if (-not $wantCard) {
  try {
    Show-DshToast
    Write-Output 'kind=winrt-toast'
    exit 0
  } catch {
    Write-Output ('winrt-toast failed: ' + $_.Exception.Message)
    if ($mode -eq 'toast') { exit 2 }
  }
}

# ── 2) 兜底:自绘 Win11 风格卡片(右下角、圆角、淡入淡出) ──────────────────
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try {
  Add-Type -Namespace Dsh -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
  [void][Dsh.Dpi]::SetProcessDPIAware()
} catch { }

[System.Windows.Forms.Application]::EnableVisualStyles()

$W = 384
$H = 104
$pad = 18
$barW = 4

$card = New-Object System.Windows.Forms.Form
$card.Text = $title
$card.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$card.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$card.ShowInTaskbar = $false
$card.TopMost = $true
$card.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$card.BackColor = [System.Drawing.Color]::FromArgb(32, 32, 32)
$card.ClientSize = New-Object System.Drawing.Size($W, $H)

$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$card.Location = New-Object System.Drawing.Point(([int]($area.Right - $W - 16)), ([int]($area.Bottom - $H - 16)))

$radius = 14
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $radius, $radius, 180, 90)
$path.AddArc(($W - $radius - 1), 0, $radius, $radius, 270, 90)
$path.AddArc(($W - $radius - 1), ($H - $radius - 1), $radius, $radius, 0, 90)
$path.AddArc(0, ($H - $radius - 1), $radius, $radius, 90, 90)
$path.CloseFigure()
$card.Region = New-Object System.Drawing.Region($path)

$bar = New-Object System.Windows.Forms.Panel
$bar.Location = New-Object System.Drawing.Point(0, 0)
$bar.Size = New-Object System.Drawing.Size($barW, $H)
$bar.BackColor = [System.Drawing.Color]::FromArgb(47, 107, 255)
$card.Controls.Add($bar)

function Add-DshLabel {
  param([string]$Text, [int]$Y, [int]$H, [double]$FontSize, [bool]$Bold, $Color)
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Text
  $label.Location = New-Object System.Drawing.Point($pad, $Y)
  $label.Size = New-Object System.Drawing.Size(($W - $pad - 16), $H)
  $label.AutoSize = $false
  $label.BackColor = [System.Drawing.Color]::Transparent
  $label.ForeColor = $Color
  $style = [System.Drawing.FontStyle]::Regular
  if ($Bold) { $style = [System.Drawing.FontStyle]::Bold }
  $label.Font = New-Object System.Drawing.Font('Segoe UI', $FontSize, $style)
  $label.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
  $card.Controls.Add($label)
}

Add-DshLabel $app   8 14 8.0  $true  ([System.Drawing.Color]::FromArgb(154, 154, 154))
Add-DshLabel $title 26 24 11.0 $true  ([System.Drawing.Color]::FromArgb(255, 255, 255))
Add-DshLabel $body  50 34 9.0  $false ([System.Drawing.Color]::FromArgb(200, 200, 200))

# 事件处理器统一走 $global:* —— 处理器由消息循环在别的时机调用,
# 只认全局限定名最稳(不依赖动态作用域的读取链)。
$global:dshCard = $card
$global:dshTick = 0
$global:dshDwell = $dwellMs
$global:dshTimer = New-Object System.Windows.Forms.Timer
$global:dshTimer.Interval = 20
$global:dshTimer.Add_Tick({
  $global:dshTick = $global:dshTick + 20
  $t = $global:dshTick
  if ($t -lt 240) {
    $global:dshCard.Opacity = $t / 240.0
  } elseif ($t -lt ($global:dshDwell + 240)) {
    $global:dshCard.Opacity = 1.0
  } elseif ($t -lt ($global:dshDwell + 640)) {
    $global:dshCard.Opacity = [Math]::Max(0.0, (($global:dshDwell + 640) - $t) / 400.0)
  } else {
    $global:dshTimer.Stop()
    $global:dshCard.Close()
  }
})

$card.Opacity = 0
$card.Add_Click({ $global:dshCard.Close() })
foreach ($child in $card.Controls) { $child.Add_Click({ $global:dshCard.Close() }) }

$global:dshTimer.Start()
[System.Windows.Forms.Application]::Run($card)
Write-Output 'kind=winforms-card'
exit 0
`;
}

/**
 * popup 模式的 PowerShell 侧脚本:**一次执行一个新窗口**,编号自增、叠着往上排,
 * 默认 `dwellMs` 之后自动淡出、点一下立即关,`--sticky` 则不自动关。
 *
 * 这条路刻意**不碰系统通知平台**——窗口是本进程自己创建的,没有"被专注助手压掉"
 * 或"同 Tag 被替换"的问题,所以连续跑多少次就弹多少个,这才是"确定看得见"的提醒。
 */
function buildPopupScript(opts) {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
${psSignalSnippet(opts.mode)}
$big       = ${psLiteral(opts.text)}
$app       = ${psLiteral(APP_NAME)}
$countFile = ${psLiteral(COUNT_FILE)}
$dwellMs   = ${Number(opts.dwellMs)}
$sticky    = ${opts.sticky ? '$true' : '$false'}
$silent    = ${opts.silent ? '$true' : '$false'}
$grabFocus = ${opts.focus ? '$true' : '$false'}
$slots     = ${POPUP_SLOTS}
$cwd       = (Get-Location).Path

# ── 计数:窗口上那句「第 N 次」就是"命令又跑了一次"的直接判据 ──────────────
$n = 0
try {
  if (Test-Path -LiteralPath $countFile) {
    $raw = (Get-Content -LiteralPath $countFile -Raw).Trim()
    if ($raw -match '^\\d+$') { $n = [int]$raw }
  }
} catch { }
$n = $n + 1
try { Set-Content -LiteralPath $countFile -Value $n -Encoding ascii } catch { }

if (-not $silent) {
  try { [System.Media.SystemSounds]::Asterisk.Play() } catch { }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try {
  Add-Type -Namespace Dsh -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
  [void][Dsh.Dpi]::SetProcessDPIAware()
} catch { }
${opts.focus ? focusHelperScript() : ''}
[System.Windows.Forms.Application]::EnableVisualStyles()

$W = 420
$H = 116
$pad = 18
$barW = 4

$stamp = (Get-Date).ToString('HH:mm:ss')
$head  = '第 ' + $n + ' 次执行 · ' + $stamp
if ($cwd.Length -gt 46) { $cwd = $cwd.Substring(0, 22) + '...' + $cwd.Substring($cwd.Length - 21) }
$meta  = $cwd

$form = New-Object System.Windows.Forms.Form
# 窗口标题保持固定:既是任务栏/枚举时的识别名,也让"叠加了几个"肉眼可数。
$form.Text = $app
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.BackColor = [System.Drawing.Color]::FromArgb(32, 32, 32)
$form.ClientSize = New-Object System.Drawing.Size($W, $H)

# 叠放:编号对槽位取模,自下而上排;上一个窗口早关掉时槽位自然空出来重用。
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$slot = ($n - 1) % $slots
$y = [int]($area.Bottom - $H - 16 - ($slot * ($H + 10)))
if ($y -lt $area.Top) { $y = [int]($area.Top + 8) }
$form.Location = New-Object System.Drawing.Point(([int]($area.Right - $W - 16)), $y)

$radius = 14
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $radius, $radius, 180, 90)
$path.AddArc(($W - $radius - 1), 0, $radius, $radius, 270, 90)
$path.AddArc(($W - $radius - 1), ($H - $radius - 1), $radius, $radius, 0, 90)
$path.AddArc(0, ($H - $radius - 1), $radius, $radius, 90, 90)
$path.CloseFigure()
$form.Region = New-Object System.Drawing.Region($path)

$bar = New-Object System.Windows.Forms.Panel
$bar.Location = New-Object System.Drawing.Point(0, 0)
$bar.Size = New-Object System.Drawing.Size($barW, $H)
$bar.BackColor = [System.Drawing.Color]::FromArgb(47, 107, 255)
$form.Controls.Add($bar)

function Add-DshLabel {
  param([string]$Text, [int]$Y, [int]$H, [double]$FontSize, [bool]$Bold, $Color)
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Text
  $label.Location = New-Object System.Drawing.Point($pad, $Y)
  $label.Size = New-Object System.Drawing.Size(($W - $pad - 16), $H)
  $label.AutoSize = $false
  $label.BackColor = [System.Drawing.Color]::Transparent
  $label.ForeColor = $Color
  $style = [System.Drawing.FontStyle]::Regular
  if ($Bold) { $style = [System.Drawing.FontStyle]::Bold }
  $label.Font = New-Object System.Drawing.Font('Segoe UI', $FontSize, $style)
  $label.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
  $form.Controls.Add($label)
}

Add-DshLabel ($app + ' · 开始前命令') 6 14 8.0 $false ([System.Drawing.Color]::FromArgb(154, 154, 154))
Add-DshLabel $big    22 30 12.0 $true  ([System.Drawing.Color]::FromArgb(255, 255, 255))
Add-DshLabel $head   54 20 9.0  $false ([System.Drawing.Color]::FromArgb(120, 190, 255))
Add-DshLabel $meta   74 20 8.0  $false ([System.Drawing.Color]::FromArgb(180, 180, 180))

$global:dshForm  = $form
$global:dshTick  = 0
$global:dshDwell = $dwellMs
$global:dshSticky = $sticky
$global:dshTimer = New-Object System.Windows.Forms.Timer
$global:dshTimer.Interval = 20
$global:dshTimer.Add_Tick({
  $global:dshTick = $global:dshTick + 20
  $t = $global:dshTick
  if ($t -lt 200) {
    $global:dshForm.Opacity = $t / 200.0
  } elseif ($global:dshSticky) {
    $global:dshForm.Opacity = 1.0
  } elseif ($t -lt ($global:dshDwell + 200)) {
    $global:dshForm.Opacity = 1.0
  } elseif ($t -lt ($global:dshDwell + 600)) {
    $global:dshForm.Opacity = [Math]::Max(0.0, (($global:dshDwell + 600) - $t) / 400.0)
  } else {
    $global:dshTimer.Stop()
    $global:dshForm.Close()
  }
})

$form.Opacity = 0
$form.Add_Click({ $global:dshForm.Close() })
foreach ($child in $form.Controls) { $child.Add_Click({ $global:dshForm.Close() }) }

$form.Show()
$form.Refresh()
$focused = $false
if ($grabFocus) {
  try { $focused = Focus-DshWindow $form.Handle } catch { }
}
$global:dshTimer.Start()
[System.Windows.Forms.Application]::Run($form)
Write-Output ('kind=winforms-popup n=' + $n + ' slot=' + $slot + ' focused=' + $focused)
exit 0
`;
}

/** PowerShell 从 UTF-16LE 解码 `-EncodedCommand`,这是中文能逐字保真的关键。 */
function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * 记事本模式:正文由 Node 直写 UTF-8。**这是中文不经命令行的关键一步**——
 * 之后 PowerShell 只需要一条纯 ASCII 的路径。写失败(只读沙箱等)如实回报,
 * 但不阻断:记事本照样会开着,只是内容可能还是上一次的。
 */
function writeDoc(opts) {
  try {
    writeFileSync(opts.doc, opts.text + '\n', 'utf8');
    return true;
  } catch (error) {
    process.stdout.write(`[test-start] doc write failed: ${error.message}\n`);
    return false;
  }
}

/** 读 popup 计数器,顺便算出"这一次会是第几号"。读不出来就当 0。 */
function readPopupCount() {
  try {
    const raw = readFileSync(COUNT_FILE, 'utf8').trim();
    return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * 覆盖写 {@link MARKER}:ISO 时刻 + 本次模式 + 模式相关内容 + 工作目录。
 * 供自动化判断"开始前命令此刻执行过",失败一律忽略。
 */
function writeMarker(opts, docWritten, plannedCount) {
  const lines = [new Date().toISOString(), `mode=${opts.mode}`];
  if (opts.mode === 'notepad') {
    lines.push(
      `text=${opts.text}`,
      `doc=${opts.doc}`,
      `docWritten=${docWritten}`,
      `launched=${opts.launch}`,
      `new=${opts.forceNew}`,
    );
  } else if (opts.mode === 'popup') {
    lines.push(
      `text=${opts.text}`,
      `popupCount=${plannedCount}`,
      `dwellMs=${opts.dwellMs}`,
      `sticky=${opts.sticky}`,
      `silent=${opts.silent}`,
      `focus=${opts.focus}`,
      `launched=${opts.launch}`,
    );
  } else {
    lines.push(`title=${opts.title}`, `body=${opts.body}`, `silent=${opts.silent}`);
  }
  lines.push(`cwd=${process.cwd()}`, `nodePid=${process.pid}`, '');
  try {
    writeFileSync(MARKER, lines.join('\n'), 'utf8');
  } catch { /* 只读沙箱等:标记写不了不影响动作 */ }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 子进程有没有在 `since` 之后刷过"我起来了"信号(见 {@link SIGNAL_FILE})。 */
function signalAfter(since) {
  try {
    return statSync(SIGNAL_FILE).mtimeMs >= since;
  } catch {
    return false;
  }
}

/** 动作脚本的 powershell 命令行参数。 */
function actionArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)];
}

/**
 * 一级启动器:**让 PowerShell 用 `Start-Process` 拉起真正的动作进程**。
 *
 * 为什么不是直接 `spawn(…, { detached: true })`:2026-09-30 实测(经真实插件路径跑真回合,
 * 四种一次起好、各写一个"12 秒后我还活着"文件)——**detached 的那个连启动都没启动**
 * (`started=False`),而 `Start-Process` 的孙进程与 WMI 建的进程都活过了 12 秒、
 * 也活过了宿主那条「开始前命令」shell 的退出。也就是说 detached 这条路在本机是**假成功**:
 * 命令"跑了"、窗口却不出现,正是"我明明执行了却没有弹窗"的现场。
 */
function launcherScript(script) {
  const quoted = actionArgs(script).map(psLiteral).join(', ');
  const debugLog = process.env.DSH_TEST_START_DEBUG_LOG;
  const redirect = debugLog
    ? ` -RedirectStandardOutput ${psLiteral(debugLog)} -RedirectStandardError ${psLiteral(`${debugLog}.err`)}`
    : '';
  return `
$ErrorActionPreference = 'Stop'
Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -PassThru${redirect} -ArgumentList @(${quoted}) | Out-Null
exit 0
`;
}

/** 二级兜底启动器:经 WMI 建进程(父进程是 WmiPrvSE,天然不在本进程的任务对象里)。 */
function wmiScript(script) {
  const cmdline = 'powershell.exe ' + actionArgs(script).join(' ');
  return `
$ErrorActionPreference = 'Stop'
$null = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psLiteral(cmdline)} }
exit 0
`;
}

/** 跑一个短命的 PowerShell 直到它退出(启动器只活几百毫秒),超时即放弃。 */
function runToExit(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', args, { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退出 */ }
      resolve(null);
    }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
  });
}

/** 等动作进程上报"我起来了";等到就是"这次投递真的落地了"。 */
async function waitSignal(since, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signalAfter(since)) return true;
    await delay(100);
  }
  return signalAfter(since);
}

/**
 * 投递动作并**确认落地**,失败就换一条机制重投。
 *
 * 顺序:① `Start-Process` 启动器(实测能活过宿主 shell 的退出)→ ② WMI 建进程(独立于
 * 本进程的任务对象)→ ③ 直接 spawn(最不济的一档,只在本进程活着时有效)。
 * 每一档都以「动作进程有没有刷新信号文件」为准,所以 stdout 上的 `confirmed=Y` 是
 * 实测结论,而不是"我以为我发出去了"。
 */
async function dispatchAction(script) {
  const since = Date.now();
  try { rmSync(SIGNAL_FILE, { force: true }); } catch { /* 没有就算了 */ }

  const psArgs = (command) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command];

  await runToExit(psArgs(launcherScript(script)), 8000);
  if (await waitSignal(since, 4000)) return { path: 'start-process', confirmed: true, pid: null };

  await runToExit(psArgs(wmiScript(script)), 8000);
  if (await waitSignal(since, 4000)) return { path: 'wmi', confirmed: true, pid: null };

  let pid = null;
  try {
    const child = spawn('powershell.exe', actionArgs(script), { stdio: 'ignore', windowsHide: true });
    child.unref();
    pid = child.pid;
  } catch { /* 起不来就算了 */ }
  return { path: 'plain', confirmed: await waitSignal(since, 4000), pid };
}

function printHelp() {
  process.stdout.write([
    'test-start.js —— dsh-start-command 的「开始前命令」冒烟脚本',
    '',
    '  右下角弹窗(默认,推荐):',
    '    node test-start.js                    每跑一次就新弹一个窗口,写着 Harness 开始了。',
    '    node test-start.js "自定义内容"        位置参数 = 弹窗上那行大字',
    '    node test-start.js --sticky           不自动关,必须点掉',
    '    node test-start.js --duration=3000    停留毫秒(默认 9000)',
    '    node test-start.js --silent           不播提示音',
    '    node test-start.js --focus            连前台焦点一起抢(默认只置顶)',
    '    node test-start.js --no-launch        只写标记,不弹窗(自动化用)',
    '    # 窗口第二行的「第 N 次」来自 %TEMP%\\harness-popup-count.txt,连续执行即连续编号。',
    '',
    '  记事本模式:',
    '    node test-start.js --notepad          打开记事本并写入 Harness 开始了。',
    '    node test-start.js --notepad --new    强制新开窗口(默认复用已开着这份文档的窗口)',
    '    node test-start.js --notepad --file=D:\\a\\b.txt   换一份文档',
    '',
    '  系统通知模式(可能被系统静音/替换,不保证弹得出来):',
    '    node test-start.js --notify           右下角系统通知(不可用时自动退到自绘卡片)',
    '    node test-start.js --toast            强制真·Windows 通知',
    '    node test-start.js --card             强制旧版自绘卡片(6 秒、不叠放)',
    '    node test-start.js --body="正文"       改通知正文',
    '',
    '  排障:',
    '    node test-start.js --wait             前台等待并打印实际走的那条路',
    '',
    '当「开始前命令」使用:设置 → 开始前命令 → 填 `node test-start.js`(工作目录=会话目录)。',
    '',
  ].join('\n'));
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[test-start] 参数错误: ${error.message}\n`);
    return 1;
  }
  if (opts.help) { printHelp(); return 0; }

  if (!IS_WINDOWS) {
    // 非 Windows 上什么事都不做也算成功:这条命令被当成「开始前命令」时不该拖垮回合。
    process.stdout.write(`[test-start] skipped: platform=${process.platform} (desktop action is Windows-only)\n`);
    return 0;
  }

  const docWritten = opts.mode === 'notepad' ? writeDoc(opts) : undefined;
  const plannedCount = opts.mode === 'popup' && opts.launch ? readPopupCount() + 1 : readPopupCount();
  writeMarker(opts, docWritten, plannedCount);

  if (!opts.launch && (opts.mode === 'notepad' || opts.mode === 'popup')) {
    // 自动化路径:不开窗口,stdout 那条 kind=* 就是判据,标记文件是证据。
    const detail = opts.mode === 'notepad'
      ? `doc=${opts.doc} chars=${opts.text.length} docWritten=${docWritten}`
      : `text=${opts.text} planned=${plannedCount}`;
    process.stdout.write(`[test-start] kind=${opts.mode} dry=1 ${detail}\n`);
    return 0;
  }

  const script = opts.mode === 'notepad'
    ? buildNotepadScript(opts)
    : (opts.mode === 'popup' ? buildPopupScript(opts) : buildNotificationScript(opts));
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodeCommand(script),
  ];

  if (opts.wait) {
    // 排障模式:前台跑完,把 PowerShell 自己报的那条 kind=* 原样透出。
    // 弹窗模式下这会一直等到窗口关闭(或点掉),属预期。
    const child = spawn('powershell.exe', args, { stdio: 'inherit' });
    child.on('exit', (code) => {
      process.stdout.write(`[test-start] powershell exit=${code} mode=${opts.mode}\n`);
    });
    return 0;
  }

  // 默认:投出去之后父进程立刻退出 —— 动作绝不会阻塞这一回合。
  // 但投递要**确认落地**并写明走的是哪条机制(见 {@link dispatchAction}:
  // detached 在本机是假成功,真正活下来的是 Start-Process / WMI 这两条)。
  const result = await dispatchAction(script);
  if (opts.mode === 'popup' && opts.launch && result.confirmed) {
    // 计数器由动作进程自增,投递确认后回读一次,让标记里的编号与窗口上的编号一致。
    writeMarker(opts, docWritten, readPopupCount());
  }
  const detail = opts.mode === 'notepad'
    ? `doc=${opts.doc} chars=${opts.text.length} docWritten=${docWritten} new=${opts.forceNew}`
    : (opts.mode === 'popup'
      ? `text=${opts.text} count=${plannedCount} dwellMs=${opts.dwellMs} sticky=${opts.sticky}`
      : `titleChars=${opts.title.length} silent=${opts.silent}`);
  process.stdout.write(
    `[test-start] dispatched via=${result.path} pid=${result.pid ?? '-'} mode=${opts.mode}` +
    ` confirmed=${result.confirmed ? 'Y' : 'n'} ${detail}\n`,
  );
  return 0;
}

main().then((code) => { process.exitCode = code; });
