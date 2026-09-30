#!/usr/bin/env node
/**
 * test-start.js —— dsh-start-command 的「开始前命令」冒烟脚本。
 *
 * 作用:在桌面上留下一个**看得见**的痕迹,证明「开始前命令」真的在模型请求之前跑过了。
 * 默认动作(**2026-09-30 起**):打开系统记事本,并在里面写入一行 `Harness 开始了。`。
 * 把它填进「设置 → 开始前命令」(`node test-start.js`),之后每次你主动发一条对话、
 * 且当时没有别的 agent 在跑,记事本就会在消息正式发给大模型之前被打开(或拉到前台)。
 *
 * 三种动作,`--notepad`(默认)/ `--notify` / `--toast` / `--card` 四选一:
 *   1. **记事本**(默认,`--notepad`):先把一行文字写进 `%TEMP%\harness-started.txt`,
 *      再让 `notepad.exe` 打开这份文档;若已有一个开着同一份文件的记事本窗口,就只把它
 *      拉到前台(不叠窗口;`--new` 可强制新开)。`--no-launch` 只写文件不开窗口。
 *   2. **真·Windows 通知**(`--notify` 自动 / `--toast` 强制,WinRT
 *      `ToastNotificationManager`)——右下角 toast,同时在通知中心留一条。
 *      AUMID 借用系统里必定存在的「Windows PowerShell」(开始菜单里的 AppID),
 *      因此**不需要注册应用、不需要打包、无需管理员权限**。
 *   3. **自绘 Win11 风格卡片**(`--card`,WinForms)——万一 toast 路径不可用时的兜底:
 *      无边框、圆角、右下角、淡入、6 秒后淡出,点一下立即关掉。
 *
 * 三个必须在实现里解决的问题:
 *   - **中文不能走命令行参数**:`powershell -Command "…中文…"` 会被控制台代码页
 *     按 ANSI 解码,「开始前执行成功」在脚本里就变成乱码。通知路径一律用
 *     `-EncodedCommand`(UTF-16LE + base64)传脚本;记事本路径更彻底——**正文由 Node
 *     直接以 UTF-8 写进文件**,PowerShell 只拿一条纯 ASCII 的路径去启动记事本,
 *     中文根本不经过命令行。
 *   - **不能阻塞「开始前命令」**:动作进程 `detached` 起、父进程立即退出,所以它绝不会
 *     把这一回合卡住;即便宿主在命令结束后回收进程树,动作进程自成一个进程组也不会被带走。
 *     (`--wait` 是排障用的前台例外。)
 *   - **后台进程拉起的窗口默认不在前台**:所以记事本启动后要轮询窗口句柄,再用
 *     `AttachThreadInput` + `SetForegroundWindow` 组合把它拉到最前,并把结果打进 stdout。
 *
 * 用法:
 *   node test-start.js                        # 打开记事本并写入 `Harness 开始了。`
 *   node test-start.js "自定义内容"            # 位置参数 = 记事本正文(通知模式下是标题)
 *   node test-start.js --text="自定义内容"     # 同上,显式写法
 *   node test-start.js --file=D:\a\b.txt      # 换一份文档
 *   node test-start.js --new                  # 强制新开记事本窗口(默认复用已有窗口)
 *   node test-start.js --no-launch            # 只写文件/标记,不开窗口(自动化用)
 *   node test-start.js --toast                # 改弹「开始前执行成功」系统通知
 *   node test-start.js --card                 # 改弹右下角自绘卡片
 *   node test-start.js --toast --body="第一行" --silent
 *   node test-start.js --wait                 # 前台等待并打印实际走的那条路(排障用)
 *   node test-start.js --duration=3000        # 卡片停留毫秒
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
const { writeFileSync } = require('node:fs');
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
 * 记事本模式写入并打开的文档。**路径保持纯 ASCII**——中文只活在文件内容里,
 * 于是命令行、控制台代码页、PowerShell 的 `-EncodedCommand` 都不参与中文传递。
 */
const DEFAULT_DOC = join(tmpdir(), 'harness-started.txt');

/** 「Windows PowerShell」在开始菜单里的 AppUserModelID —— 系统自带,故 toast 无需注册应用。 */
const PS_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/** 通知里显示的来源名(卡片第一行小字)。 */
const APP_NAME = 'dsh-start-command';

const DEFAULT_TITLE = '开始前执行成功';
const DEFAULT_BODY = '开始前命令已在模型请求前执行';
const DEFAULT_TEXT = 'Harness 开始了。';
const DEFAULT_DWELL_MS = 6000;

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

function parseArgs(argv) {
  const opts = {
    mode: 'notepad',      // notepad | notify | toast | card
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
    wait: false,
    dwellMs: DEFAULT_DWELL_MS,
    help: false,
  };
  const positional = [];
  for (const raw of argv) {
    const arg = String(raw);
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--notepad') { opts.mode = 'notepad'; continue; }
    if (arg === '--notify') { opts.mode = 'notify'; continue; }
    if (arg === '--card') { opts.mode = 'card'; continue; }
    if (arg === '--toast') { opts.mode = 'toast'; continue; }
    if (arg === '--silent' || arg === '-s') { opts.silent = true; continue; }
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
  // 位置参数 = **当前模式的主要内容**:记事本模式是正文,通知模式是标题(其后是正文)。
  // 显式 `--text=` / `--title=` / `--body=` 优先,位置参数只做补充。
  if (positional.length > 0) {
    if (opts.mode === 'notepad') {
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

/**
 * 覆盖写 {@link MARKER}:ISO 时刻 + 本次模式 + 模式相关内容 + 工作目录。
 * 供自动化判断"开始前命令此刻执行过",失败一律忽略。
 */
function writeMarker(opts, docWritten) {
  const lines = [new Date().toISOString(), `mode=${opts.mode}`];
  if (opts.mode === 'notepad') {
    lines.push(
      `text=${opts.text}`,
      `doc=${opts.doc}`,
      `docWritten=${docWritten}`,
      `launched=${opts.launch}`,
      `new=${opts.forceNew}`,
    );
  } else {
    lines.push(`title=${opts.title}`, `body=${opts.body}`, `silent=${opts.silent}`);
  }
  lines.push(`cwd=${process.cwd()}`, `nodePid=${process.pid}`, '');
  try {
    writeFileSync(MARKER, lines.join('\n'), 'utf8');
  } catch { /* 只读沙箱等:标记写不了不影响动作 */ }
}

function printHelp() {
  process.stdout.write([
    'test-start.js —— dsh-start-command 的「开始前命令」冒烟脚本',
    '',
    '  记事本模式(默认):',
    '    node test-start.js                    打开记事本并写入 Harness 开始了。',
    '    node test-start.js "自定义内容"        位置参数 = 写进记事本的那行字',
    '    node test-start.js --text="正文"       同上,显式写法',
    '    node test-start.js --file=D:\\a\\b.txt  换一份文档(默认 %TEMP%\\harness-started.txt)',
    '    node test-start.js --new              强制新开窗口(默认复用已开着这份文档的窗口)',
    '    node test-start.js --no-launch        只写文件与标记,不开窗口(自动化用)',
    '',
    '  通知模式:',
    '    node test-start.js --notify           右下角系统通知(不可用时自动退到自绘卡片)',
    '    node test-start.js --toast            强制真·Windows 通知',
    '    node test-start.js --card             强制右下角自绘卡片',
    '    node test-start.js --body="正文"       改通知正文',
    '    node test-start.js --silent           静音(默认带系统提示音)',
    '    node test-start.js --duration=3000    卡片停留毫秒',
    '',
    '  排障:',
    '    node test-start.js --wait             前台等待并打印实际走的那条路',
    '',
    '当「开始前命令」使用:设置 → 开始前命令 → 填 `node test-start.js`(工作目录=会话目录)。',
    '',
  ].join('\n'));
}

function main() {
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
  writeMarker(opts, docWritten);

  if (opts.mode === 'notepad' && !opts.launch) {
    // 自动化路径:不开窗口,stdout 那条 kind=notepad 就是判据,标记文件是证据。
    process.stdout.write(`[test-start] kind=notepad dry=1 doc=${opts.doc} chars=${opts.text.length} docWritten=${docWritten}\n`);
    return 0;
  }

  const script = opts.mode === 'notepad' ? buildNotepadScript(opts) : buildNotificationScript(opts);
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encodeCommand(script),
  ];

  if (opts.wait) {
    // 排障模式:前台跑完,把 PowerShell 自己报的那条 kind=* 原样透出。
    const child = spawn('powershell.exe', args, { stdio: 'inherit' });
    child.on('exit', (code) => {
      process.stdout.write(`[test-start] powershell exit=${code} mode=${opts.mode}\n`);
    });
    return 0;
  }

  // 默认:detached + 忽略 stdio,父进程立刻退出 —— 动作绝不会阻塞这一回合,
  // 也不会被宿主在命令结束后回收进程树时带走。
  const child = spawn('powershell.exe', args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: opts.mode !== 'card',
  });
  child.unref();
  const detail = opts.mode === 'notepad'
    ? `doc=${opts.doc} chars=${opts.text.length} docWritten=${docWritten} new=${opts.forceNew}`
    : `titleChars=${opts.title.length} silent=${opts.silent}`;
  process.stdout.write(`[test-start] dispatched pid=${child.pid} mode=${opts.mode} ${detail}\n`);
  return 0;
}

process.exitCode = main();
