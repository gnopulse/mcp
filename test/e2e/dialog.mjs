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

const clickWindows = (name) => {
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$name = [System.Windows.Automation.AutomationElement]::NameProperty
$any = [System.Windows.Automation.TreeScope]::Descendants
$kids = [System.Windows.Automation.TreeScope]::Children
for ($i = 0; $i -lt 60; $i++) {
  $w = $root.FindFirst($kids, (New-Object System.Windows.Automation.PropertyCondition($name, '${TITLE}')))
  if ($w) {
    $b = $w.FindFirst($any, (New-Object System.Windows.Automation.PropertyCondition($name, '${name}')))
    if (-not $b) {
      $all = $w.FindAll($any, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($e in $all) { Write-Output ('found: ' + $e.Current.ControlType.ProgrammaticName + ' ' + $e.Current.Name) }
      exit 2
    }
    $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    exit 0
  }
  Start-Sleep -Milliseconds 500
}
exit 1`;
  return runIt("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
};

const pressLinux = (...keys) =>
  runIt("sh", ["-c", `id=$(xdotool search --sync --onlyvisible --name "${TITLE}" | head -1) && xdotool windowfocus --sync "$id" && xdotool key --delay 200 ${keys.join(" ")}`]);

const approve = () => (process.platform === "win32" ? clickWindows("OK") : pressLinux("Tab", "Return"));
const decline = () => (process.platform === "win32" ? clickWindows("Cancel") : pressLinux("Return"));

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
