#!/usr/bin/env python3
"""Drives `setup` and `backup` in a real terminal. Needs GNOTX_BIN; GNOKEY_BIN adds restore checks.
On Windows it needs the pywinpty package."""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

WINDOWS = sys.platform == "win32"
if WINDOWS:
    from winpty import PtyProcess
else:
    import pty

LAUNCHER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bin", "launch.mjs")
GNOTX = os.environ["GNOTX_BIN"]
GNOKEY = os.environ.get("GNOKEY_BIN")
WORK = tempfile.mkdtemp(prefix="gnopulse-terminal-")
HOME = os.path.join(WORK, "home")
ENV = {**os.environ, "GNOPULSE_AGENT_HOME": HOME, "TERM": "xterm", "GNOPULSE_APPROVAL_DIALOG": "off"}
ENV.pop("GNOPULSE_API_KEY", None)
ALT_ON = "\x1b[?1049h"
ALT_OFF = "\x1b[?1049l"
failed = []


def check(name, ok):
    print(("ok  " if ok else "FAIL"), name)
    if not ok:
        failed.append(name)


class Terminal:
    def __init__(self, *args, env=ENV):
        self.raw = ""
        self.at = 0
        if WINDOWS:
            self.proc = PtyProcess.spawn(["node", LAUNCHER, *args], env=env)
        else:
            self.fd, child = pty.openpty()
            self.proc = subprocess.Popen(["node", LAUNCHER, *args], stdin=child, stdout=child, stderr=child, env=env, close_fds=True)
            os.close(child)
        self.reader = threading.Thread(target=self.read_all, daemon=True)
        self.reader.start()

    def read_all(self):
        try:
            while True:
                data = self.proc.read(65536) if WINDOWS else os.read(self.fd, 65536).decode(errors="replace")
                if not data:
                    break
                self.raw += data
        except (OSError, EOFError):
            pass

    @property
    def text(self):
        return re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07", "", self.raw)

    def expect(self, pattern, timeout=90):
        end = time.time() + timeout
        while time.time() < end:
            found = re.search(pattern, self.text[self.at :])
            if found:
                self.at += found.end()
                return found
            time.sleep(0.1)
        sys.exit(f"timed out waiting for {pattern!r}")

    def write(self, data):
        if WINDOWS:
            self.proc.write(data)
        else:
            os.write(self.fd, data.encode())

    def send(self, line):
        self.write(line + "\r")

    def finish(self):
        self.reader.join(30)
        if WINDOWS:
            self.proc.wait()
            return self.proc.exitstatus
        return self.proc.wait()


def to_wallet_step(agent):
    term = Terminal("setup")
    for question, answer in (("Which app", "6"), ("Which network", "2"), ("What may the agent do", "2")):
        term.expect(question)
        term.expect("> ")
        term.send(answer)
    term.expect("Name this agent's wallet.*: ")
    term.send(agent)
    term.expect("API key.*: ")
    term.send("")
    return term


def to_cursor_write(agent, user_home):
    term = Terminal("setup", env={**ENV, "HOME": user_home, "USERPROFILE": user_home})
    for question, answer in (("Which app", "3"), ("Which network", "2"), ("What may the agent do", "2")):
        term.expect(question)
        term.expect("> ")
        term.send(answer)
    term.expect("Name this agent's wallet.*: ")
    term.send(agent)
    term.expect("API key.*: ")
    term.send("")
    term.expect(r"Write it to .*: ")
    term.send("y")
    return term


def read_phrase(term):
    term.expect(r"It is shown only here")
    return re.findall(r"\d+\. ([a-z]+)", term.expect(r"(?s)(.*?)Write it down").group(1))


def restored_address(args, stdin):
    home = tempfile.mkdtemp(dir=WORK)
    # Bytes, so Windows keeps "\n": gnokey would read a "\r" as part of the password.
    done = subprocess.run([GNOKEY, *args, "-home", home, "-insecure-password-stdin"], input=stdin.encode(), capture_output=True)
    if done.returncode != 0:
        print(done.stderr.decode(errors="replace")[-400:])
    return subprocess.run([GNOKEY, "list", "-home", home], capture_output=True, text=True).stdout


for command in ("setup", "backup"):
    done = subprocess.run(["node", LAUNCHER, command], capture_output=True, text=True, env=ENV, stdin=subprocess.DEVNULL)
    check(f"{command} refuses without a terminal", done.returncode == 1 and "terminal" in done.stdout)

term = to_wallet_step("cancelled")
term.expect("Press Enter once")
term.send("q")
term.expect("No wallet was created")
term.finish()
check("cancelling restores the terminal", WINDOWS or ALT_OFF in term.raw)

term = to_wallet_step("stopped")
term.expect("Press Enter once")
term.write("\x04")
term.expect("Stopped")
check("ctrl-d stops setup and restores the terminal", term.finish() == 130 and (WINDOWS or ALT_OFF in term.raw))

term = to_wallet_step("kept")
words = read_phrase(term)
check("the phrase has 24 words", len(words) == 24)
term.expect("Press Enter once")
term.send("")
for _ in range(2):
    term.expect(r"Word \d+: ")
    term.send("wrong")
term.expect("does not match")
term.send("")
check("wrong words show the same phrase again", read_phrase(term) == words)
term.expect("Press Enter once")
term.send("")
for _ in range(2):
    position = int(term.expect(r"Word (\d+): ").group(1))
    term.send(words[position - 1])
term.expect("Recovery phrase saved")
address = term.expect(r"Wallet: (g1[a-z0-9]+)").group(1)
term.expect("Before you fund it")
check("setup finishes", term.finish() == 0)
if not WINDOWS:  # the Windows terminal layer redraws text and may not pass these codes on
    outside = re.sub(re.escape(ALT_ON) + ".*?" + re.escape(ALT_OFF), "", term.raw, flags=re.S)
    # Numbered, as the phrase is shown: a lone word such as "wallet" also appears in normal text.
    shown = [f"{i + 1}. {word}" for i, word in enumerate(words)]
    check("the phrase appears only on the temporary screen", shown[0] in term.raw and not any(line in outside for line in shown))
wallet = os.path.join(HOME, "agents", "onyx-1", "kept")
files = [os.path.join(wallet, name) for name in os.listdir(wallet) if os.path.isfile(os.path.join(wallet, name))]
check("the phrase is not in any wallet file", not any(" ".join(words) in open(f, errors="ignore").read() for f in files))
if GNOKEY:
    listed = restored_address(["add", "r", "-recover"], f"{' '.join(words)}\npw12345678\npw12345678\n")
    check("gnokey restores the address from the phrase", address in listed)

term = to_wallet_step("kept")
term.expect("already exists")
check("setup again keeps the wallet", term.expect(r"Wallet: (g1[a-z0-9]+)").group(1) == address)
term.finish()

user_home = tempfile.mkdtemp(dir=WORK)
config = os.path.join(user_home, ".cursor", "mcp.json")
term = to_cursor_write("cursor-agent", user_home)
term.expect("Press Enter once")
check("the app's config is not written while the phrase is on screen", not os.path.exists(config))
term.send("q")
term.expect("nothing was written")
term.finish()
check("cancelling at the phrase writes no config", not os.path.exists(config))
term = to_cursor_write("cursor-agent", user_home)
cursor_words = read_phrase(term)
term.expect("Press Enter once")
term.send("")
for _ in range(2):
    position = int(term.expect(r"Word (\d+): ").group(1))
    term.send(cursor_words[position - 1])
term.expect("Written")
term.expect("Before you fund it")
term.finish()
server_env = json.load(open(config))["mcpServers"]["gnopulse"]["env"]
check("the config points the app at the wallet setup made", server_env["GNOPULSE_AGENT_HOME"] == HOME)

PASSPHRASE = "correct horse battery"
out = os.path.join(WORK, "wallet.key")
term = Terminal("backup")
term.expect("Which wallet")
listing = term.expect(r"(?s)(.*?)> ").group(1)
check("backup skips a folder with no key", "cancelled" not in listing)
term.send(re.search(r"(\d+)\. kept on onyx-1", listing).group(1))
term.expect("Passphrase.*: ")
term.send("short")
term.expect("too short")
term.expect("Passphrase.*: ")
term.send(PASSPHRASE + " ")
term.expect("start or end with a space")
term.expect("Passphrase.*: ")
term.send(PASSPHRASE)
term.expect("again: ")
term.send("a different passphrase")
term.expect("did not match")
term.expect("Passphrase.*: ")
term.send(PASSPHRASE)
term.expect("again: ")
term.send(PASSPHRASE)
term.expect("Save the file as.*: ")
term.write("\x1b[A")  # the up arrow must not bring the passphrase back
term.send(out)
check("backup checks the file against the wallet", term.expect(r"decrypts back to (g1[a-z0-9]+)").group(1) == address)
check("backup finishes", term.finish() == 0)
check("the passphrase is not echoed", PASSPHRASE not in term.text)
if not WINDOWS:
    check("the file is private", oct(os.stat(out).st_mode)[-3:] == "600")
if GNOKEY:
    listed = restored_address(["import", "-name", "r", "-armor-path", out], f"{PASSPHRASE}\nnewpass1234\nnewpass1234\n")
    check("gnokey imports the file to the same address", address in listed)

shutil.rmtree(WORK, ignore_errors=True)
print("FAILED" if failed else "all checks passed")
sys.exit(1 if failed else 0)
