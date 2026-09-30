#!/usr/bin/env node
/**
 * test-start.js —— dsh-start-command 的「开始前命令」冒烟脚本。
 *
 * 作用:在 Windows 右下角弹一条 Win11 系统通知,内容 **开始前执行成功**。
 * 把它填进「设置 → 开始前命令」(`node test-start.js`),之后每次你主动发一条对话、
 * 且当时没有别的 agent 在跑,这条通知就会在消息正式发给大模型之前弹出来。
 *
 * 通知走两条路,自动择一:
 *   1. **真·Windows 通知**(WinRT `ToastNotificationManager`)——右下角 toast,
 *      同时在通知中心留一条。AUMID 借用系统里必定存在的「Windows PowerShell」
 *      (启动器里的 AppID),因此**不需要注册应用、不需要打包、无需管理员权限**。
 *   2. **自绘 Win11 风格卡片**(WinForms)——万一 toast 路径不可用时的兜底:
 *      无边框、圆角、右下角、淡入、6 秒后淡出,点一下立即关掉。
 *
 * 两个必须在实现里解决的问题:
 *   - **中文不能走命令行参数**:`powershell -Command "…中文…"` 会被控制台代码页
 *     按 ANSI 解码,「开始前执行成功」在脚本里就变成乱码。这里一律用
 *     `-EncodedCommand`(UTF-16LE + base64)传脚本,PowerShell 按 UTF-16 解码,
 *     中日韩字符逐字保真。
 *   - **不能阻塞「开始前命令」**:通知进程 `detached` 起、父进程立即退出,所以它
 *     绝不会把这一回合卡住;即便宿主在命令结束后回收进程树,通知进程自成一个进程组
 *     也不会被带走。
 *
 * 用法:
 *   node test-start.js                        # 弹「开始前执行成功」
 *   node test-start.js "自定义内容"            # 改标题
 *   node test-start.js --body="第一行" --silent
 *   node test-start.js --card                 # 强制自绘卡片
 *   node test-start.js --toast                # 强制真通知
 *   node test-start.js --wait                 # 前台等待并打印实际走的那条路(排障用)
 *   node test-start.js --duration=3000        # 卡片停留毫秒
 *
 * 每次运行还会覆盖写一份时间戳标记(`%TEMP%\dsh-start-command-last-run.txt`)——
 * 通知是给人看的,标记是给自动化看的:想验证「开始前命令有没有执行」读它的 mtime 即可,
 * 不必盯屏幕。写失败(只读沙箱)不影响通知。
 *
 * 退出码:0 = 已把通知投出去(或非 Windows 上明确跳过);1 = 参数错。
 *
 * @file 工作区根的独立测试脚本(不属于任何插件源码,不参与插件加载)
 */
'use strict';

const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const IS_WINDOWS = process.platform === 'win32';

/**
 * 每次运行覆盖写的时间戳文件。通知是给人看的,这个文件是给自动化看的:
 * 「开始前命令到底有没有执行、什么时候执行的」不必靠肉眼盯通知,读它的 mtime 即可。
 * 写失败(例如会话沙箱是只读)不影响通知,静默忽略。
 */
const MARKER = join(tmpdir(), 'dsh-start-command-last-run.txt');

/** 「Windows PowerShell」在开始菜单里的 AppUserModelID —— 系统自带,故 toast 无需注册应用。 */
const PS_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

/** 通知里显示的来源名(卡片第一行小字)。 */
const APP_NAME = 'dsh-start-command';

const DEFAULT_TITLE = '开始前执行成功';
const DEFAULT_BODY = '开始前命令已在模型请求前执行';
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
    title: DEFAULT_TITLE,
    body: DEFAULT_BODY,
    mode: 'auto',
    silent: false,
    wait: false,
    dwellMs: DEFAULT_DWELL_MS,
    help: false,
  };
  const positional = [];
  for (const raw of argv) {
    const arg = String(raw);
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--silent' || arg === '-s') { opts.silent = true; continue; }
    if (arg === '--wait' || arg === '-w') { opts.wait = true; continue; }
    if (arg === '--card') { opts.mode = 'card'; continue; }
    if (arg === '--toast') { opts.mode = 'toast'; continue; }
    if (arg.startsWith('--title=')) { opts.title = arg.slice('--title='.length); continue; }
    if (arg.startsWith('--body=')) { opts.body = arg.slice('--body='.length); continue; }
    if (arg.startsWith('--duration=')) {
      const ms = Number.parseInt(arg.slice('--duration='.length), 10);
      if (!Number.isFinite(ms) || ms < 500) throw new Error('--duration 需要 >= 500 的毫秒数');
      opts.dwellMs = ms;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`未知参数: ${arg}`);
    positional.push(arg);
  }
  if (positional.length > 0) opts.title = positional.join(' ');
  if (positional.length > 1) opts.body = positional.slice(1).join(' ');
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
 * 生成 PowerShell 侧脚本。全部中文都在这里烘焙进字符串,再由 {@link encodeCommand}
 * 以 UTF-16LE 编码送出 —— 这条路径与命令行代码页无关。
 */
function buildPowerShellScript(opts) {
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
 * 覆盖写 {@link MARKER}:ISO 时刻 + 本次的标题/内容/工作目录/模式。
 * 供自动化判断"开始前命令此刻执行过",失败一律忽略。
 */
function writeMarker(opts) {
  try {
    writeFileSync(MARKER, [
      new Date().toISOString(),
      `title=${opts.title}`,
      `body=${opts.body}`,
      `cwd=${process.cwd()}`,
      `mode=${opts.mode}`,
      `silent=${opts.silent}`,
      `nodePid=${process.pid}`,
      '',
    ].join('\n'), 'utf8');
  } catch { /* 只读沙箱等:标记写不了不影响弹通知 */ }
}

function printHelp() {
  process.stdout.write([
    'test-start.js —— dsh-start-command 的「开始前命令」冒烟脚本',
    '',
    '  node test-start.js                    弹「开始前执行成功」',
    '  node test-start.js "自定义标题"        改标题',
    '  node test-start.js --body="正文"       改正文',
    '  node test-start.js --silent           静音(默认带系统提示音)',
    '  node test-start.js --toast            强制真·Windows 通知',
    '  node test-start.js --card             强制右下角自绘卡片',
    '  node test-start.js --wait             前台等待并打印实际走的那条路',
    '  node test-start.js --duration=3000    卡片停留毫秒',
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
    process.stdout.write(`[test-start] skipped: platform=${process.platform} (notification is Windows-only)\n`);
    return 0;
  }

  writeMarker(opts);

  const script = buildPowerShellScript(opts);
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
      process.stdout.write(`[test-start] powershell exit=${code} titleChars=${opts.title.length}\n`);
    });
    return 0;
  }

  // 默认:detached + 忽略 stdio,父进程立刻退出 —— 通知绝不会阻塞这一回合,
  // 也不会被宿主在命令结束后回收进程树时带走。
  const child = spawn('powershell.exe', args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: opts.mode !== 'card',
  });
  child.unref();
  process.stdout.write(`[test-start] dispatched pid=${child.pid} mode=${opts.mode} titleChars=${opts.title.length} silent=${opts.silent}\n`);
  return 0;
}

process.exitCode = main();
