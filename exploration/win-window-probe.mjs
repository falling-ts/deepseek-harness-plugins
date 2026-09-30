#!/usr/bin/env node
/**
 * win-window-probe.mjs —— 枚举桌面上的顶层窗口,用来**客观**验证
 * 「自绘弹窗真的出现了、出现了几个、分别在哪」。
 *
 * 为什么需要它:提醒类窗口是给人看的,而自动化里没法"看一眼屏幕"。窗口是本进程
 * 自己创建的,所以「有没有这个窗口」可以用 `EnumWindows` 直接查——比截图判读更硬,
 * 也比读日志更直接(何况插件的 `ctx.logger` 在多数部署里根本不落盘)。
 *
 * 判据字段:
 *   - `vis`  —— `IsWindowVisible`,窗口真的显示着(不是创建后没 Show 的隐藏窗口);
 *   - `rect` —— 屏幕坐标,用来验证"叠放"确实是往上排而不是叠在同一处;
 *   - `pid`  —— 拥有者进程号,用于区分"这一轮新起的"与"上一轮残留的"。
 *
 * 用法:
 *   node exploration/win-window-probe.mjs                 # 列出 dsh-start-command 的窗口
 *   node exploration/win-window-probe.mjs <子串>           # 换一个标题子串
 *   node exploration/win-window-probe.mjs <子串> --all     # 连不可见的窗口一起列
 *
 * 退出码:0 = 找到了至少一个可见窗口;2 = 一个都没有。
 *
 * @file 探测脚本(不属于任何插件源码)
 */
'use strict';

import { spawnSync } from 'node:child_process';

const needle = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'dsh-start-command';
const includeHidden = process.argv.includes('--all');

const PS = `
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class DshWinProbe {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<string> Find(string needle, bool includeHidden) {
    var outp = new List<string>();
    EnumWindows((h, l) => {
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      var title = sb.ToString();
      if (title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) {
        bool vis = IsWindowVisible(h);
        if (vis || includeHidden) {
          uint pid; GetWindowThreadProcessId(h, out pid);
          RECT r; GetWindowRect(h, out r);
          var cls = new StringBuilder(256);
          GetClassName(h, cls, cls.Capacity);
          // WS_EX_TOPMOST = 0x00000008
          bool topmost = (GetWindowLong(h, -20) & 0x8) != 0;
          outp.Add(string.Format("{0} vis={1} iconic={2} topmost={3} pid={4} rect={5},{6} {7}x{8} class={9} title={10}",
            "0x" + ((long)h).ToString("X"),
            vis ? "Y" : "n", IsIconic(h) ? "Y" : "n", topmost ? "Y" : "n", pid,
            r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, cls, title));
        }
      }
      return true;
    }, IntPtr.Zero);
    return outp;
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
$hits = [DshWinProbe]::Find(${JSON.stringify(needle)}, ${includeHidden ? '$true' : '$false'})
if ($hits.Count -eq 0) { Write-Output 'NO_WINDOW'; exit 2 }
$hits | ForEach-Object { Write-Output $_ }
exit 0
`;

const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS], {
  encoding: 'utf8',
});
const stdout = (result.stdout ?? '').trim();
const stderr = (result.stderr ?? '').trim();
if (stdout) process.stdout.write(stdout + '\n');
if (result.status === 2) process.stdout.write(`(no visible top-level window whose title contains "${needle}")\n`);
if (stderr && !/^\s*$/.test(stderr)) {
  process.stdout.write(`[window-probe] powershell stderr: ${stderr.split('\n')[0]}\n`);
}
process.exitCode = result.status === 0 ? 0 : (result.status === 2 ? 2 : 1);
