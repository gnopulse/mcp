// Clicks the real approval window. Only runs with GNOPULSE_DIALOG_TEST=1, since it needs a desktop:
// Windows, or Linux with zenity, xdotool and a display.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { systemDialog } from "../../dist/signer/systemDialog.js";

const TITLE = "GnoPulse agent wallet";

if (process.env.GNOPULSE_DIALOG_TEST !== "1") {
  console.log("skip dialog: GNOPULSE_DIALOG_TEST is not set");
  process.exit(0);
}

const runIt = (file, args) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", () => resolve(1));
    child.on("close", resolve);
  });

// Real mouse and key input, as a person would answer. The window's buttons do not take UI Automation clicks.
const answerWindows = (action) => {
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Win {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int x, int y, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@
function Click($x, $y) {
  [Win]::SetCursorPos($x, $y) | Out-Null
  [Win]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [Win]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 300
}
for ($i = 0; $i -lt 60; $i++) {
  $w = [Win]::FindWindow('#32770', '${TITLE}')
  if ($w -ne [IntPtr]::Zero) {
    Start-Sleep -Milliseconds 500
    Write-Output ('window in front when it opened: ' + ([Win]::GetForegroundWindow() -eq $w))
    $r = New-Object Win+Rect
    [Win]::SetForegroundWindow($w) | Out-Null
    [Win]::GetWindowRect($w, [ref]$r) | Out-Null
    Click (($r.Left + $r.Right) / 2) ($r.Top + 10)
    if ('${action}' -eq 'Enter') {
      [Win]::keybd_event(13, 0, 0, [UIntPtr]::Zero)
      [Win]::keybd_event(13, 0, 2, [UIntPtr]::Zero)
    } else {
      $b = [Win]::FindWindowEx($w, [IntPtr]::Zero, 'Button', '${action}')
      if ($b -eq [IntPtr]::Zero) { exit 2 }
      [Win]::GetWindowRect($b, [ref]$r) | Out-Null
      Click (($r.Left + $r.Right) / 2) (($r.Top + $r.Bottom) / 2)
    }
    exit 0
  }
  Start-Sleep -Milliseconds 500
}
exit 1`;
  return runIt("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
};

const pressLinux = (...keys) =>
  runIt("sh", ["-c", `id=$(xdotool search --sync --onlyvisible --name "${TITLE}" | head -1) && xdotool windowfocus --sync "$id" && xdotool key --delay 200 ${keys.join(" ")}`]);

const approve = () => (process.platform === "win32" ? answerWindows("OK") : pressLinux("Tab", "Return"));
const decline = () => (process.platform === "win32" ? answerWindows("Enter") : pressLinux("Return"));

const dialog = systemDialog(process.env);
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

check("this machine has an approval window", dialog !== null, dialog?.kind);
if (dialog) {
  const ask = (ms) => dialog.ask("Test only.\nNothing is signed.", ms, new AbortController().signal);
  for (const [name, act, want] of [
    ["the default choice declines", decline, "decline"],
    ["the approve button approves", approve, "approve"]
  ]) {
    const answer = ask(45000);
    const driven = await act();
    check(`${name} (window found)`, driven === 0, String(driven));
    const got = await answer;
    check(name, got === want, got);
    await sleep(500);
  }
  const started = Date.now();
  check("an unanswered window times out", (await ask(2500)) === "timeout");
  check("the timeout is prompt", Date.now() - started < 15000);
}
console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
