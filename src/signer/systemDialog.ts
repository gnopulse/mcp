/**
 * Transaction approval in a native system dialog, for clients that cannot show an MCP form.
 *
 * The dialog belongs to the operating system, not the chat, so the model cannot answer it with a
 * tool call. The text reaches the dialog program as an argument or environment variable, never as
 * part of a script, so realm names and arguments cannot inject commands.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type DialogAnswer = "approve" | "decline" | "timeout" | "error";

export interface SystemDialog {
  /** Short name of the dialog backend, for status output. */
  readonly kind: string;
  ask(message: string, timeoutMs: number, signal: AbortSignal): Promise<DialogAnswer>;
}

const TITLE = "GnoPulse agent wallet";
const APPROVE = "Approve and send";

interface Command {
  file: string;
  args: string[];
  env?: Record<string, string>;
  /** Maps the exit code and stdout to an answer. */
  read(code: number | null, stdout: string): DialogAnswer;
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      /* not here */
    }
  }
  return null;
}

function macCommand(message: string, seconds: number): Command {
  const script = [
    "on run argv",
    `display dialog (item 1 of argv) with title "${TITLE}" buttons {"Cancel", "${APPROVE}"} ` +
      `default button "Cancel" cancel button "Cancel" with icon caution giving up after (item 2 of argv as integer)`,
    "end run"
  ];
  return {
    file: "/usr/bin/osascript",
    args: [...script.flatMap((line) => ["-e", line]), "--", message, String(seconds)],
    read: (code, out) =>
      code !== 0 ? "decline" : /gave up:true/.test(out) ? "timeout" : out.includes(`button returned:${APPROVE}`) ? "approve" : "decline"
  };
}

function windowsCommand(message: string, shell: string): Command {
  return {
    file: shell,
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -AssemblyName PresentationFramework; " +
        `[System.Windows.MessageBox]::Show($env:GNOPULSE_DIALOG_TEXT, '${TITLE}', 'OKCancel', 'Warning', 'Cancel')`
    ],
    env: { GNOPULSE_DIALOG_TEXT: `${message}\n\nOK = ${APPROVE}. Cancel sends nothing.` },
    read: (code, out) => (code === 0 && out.trim() === "OK" ? "approve" : "decline")
  };
}

function zenityCommand(file: string, message: string, seconds: number): Command {
  return {
    file,
    args: [
      "--question",
      "--no-markup",
      `--title=${TITLE}`,
      `--ok-label=${APPROVE}`,
      "--cancel-label=Cancel",
      "--default-cancel",
      `--timeout=${seconds}`,
      `--text=${message}`
    ],
    read: (code) => (code === 0 ? "approve" : code === 5 ? "timeout" : "decline")
  };
}

function kdialogCommand(file: string, message: string): Command {
  return {
    file,
    args: [`--title=${TITLE}`, "--warningcontinuecancel", message, `--continue-label=${APPROVE}`],
    read: (code) => (code === 0 ? "approve" : "decline")
  };
}

function run(cmd: Command, timeoutMs: number, signal: AbortSignal): Promise<DialogAnswer> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const child = spawn(cmd.file, cmd.args, {
      env: { ...process.env, ...cmd.env },
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: false
    });
    const finish = (answer: DialogAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      resolve(answer);
    };
    const onAbort = () => finish("decline");
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout!.on("data", (chunk) => (out += chunk));
    child.on("error", () => finish("error"));
    child.on("close", (code) => finish(cmd.read(code, out)));
  });
}

/**
 * The dialog for this machine, or null when there is no desktop to show it on: a remote shell,
 * a Linux session without a display or dialog program, or GNOPULSE_APPROVAL_DIALOG=off.
 */
export function systemDialog(env: NodeJS.ProcessEnv = process.env, platform = process.platform): SystemDialog | null {
  if (env.GNOPULSE_APPROVAL_DIALOG === "off") return null;
  if (env.SSH_CONNECTION || env.SSH_TTY) return null;
  let build: ((message: string, seconds: number) => Command) | null = null;
  let kind = "";
  if (platform === "darwin" && fs.existsSync("/usr/bin/osascript")) {
    build = macCommand;
    kind = "macos";
  } else if (platform === "win32") {
    const shell = onPath("powershell.exe", env) || onPath("pwsh.exe", env);
    if (shell) {
      build = (message) => windowsCommand(message, shell);
      kind = "windows";
    }
  } else if (platform === "linux" && (env.DISPLAY || env.WAYLAND_DISPLAY)) {
    const zenity = onPath("zenity", env);
    const kdialog = onPath("kdialog", env);
    if (zenity) {
      build = (message, seconds) => zenityCommand(zenity, message, seconds);
      kind = "zenity";
    } else if (kdialog) {
      build = (message) => kdialogCommand(kdialog, message);
      kind = "kdialog";
    }
  }
  if (!build) return null;
  const make = build;
  return {
    kind,
    ask: (message, timeoutMs, signal) =>
      run(make(message, Math.max(1, Math.floor(timeoutMs / 1000))), timeoutMs, signal)
  };
}
