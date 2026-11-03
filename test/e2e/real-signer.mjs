// The launcher with the real gnotx: secrets by pipe, a working token, and a recoverable wallet.
// Set GNOTX_BIN to a built gnotx; without it this skips.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backupMark, markBackedUp, runGnotx, walletDir } from "../../bin/wallet-lib.mjs";
import { check, freePort, run, startMock } from "./lib.mjs";

const LAUNCHER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/launch.mjs");
const gnotx = process.env.GNOTX_BIN;

if (!gnotx) {
  console.log("skip real-signer: GNOTX_BIN is not set");
  process.exit(0);
}

await run(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gnopulse-real-"));
  const addr = `127.0.0.1:${await freePort()}`;
  // Answers the health probe but not RPC, so a request with a good token fails only at the chain.
  const rpc = await startMock(() => ({}));
  const env = {
    ...process.env,
    GNOPULSE_AGENT_HOME: home,
    GNOPULSE_AGENT_ID: "real",
    GNOPULSE_SIGNER: "user-approval",
    GNOPULSE_SIGNER_ADDR: addr,
    GNOPULSE_APPROVAL_DIALOG: "off",
    GNO_RPC_URLS: rpc.url,
    GNOPULSE_API_BASE: "http://127.0.0.1:9"
  };
  const dir = walletDir(env, "gnoland-1", "real");
  const client = new Client({ name: "real-signer", version: "1" });
  try {
    const keygen = ["keygen", "-home", dir, "-key", "gpagent", "-secrets-stdin"];
    fs.mkdirSync(dir, { recursive: true });
    const password = "test-wallet-password";
    fs.writeFileSync(path.join(dir, ".pass"), password, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, ".serve-token"), "old");
    check("no wallet before it is asked for", !runGnotx(gnotx, [...keygen, "-no-create"], { password }, env).address);
    const { mnemonic } = runGnotx(gnotx, ["mnemonic"], null, env);
    check("the phrase has 24 words", mnemonic.split(" ").length === 24);
    const { address } = runGnotx(gnotx, keygen, { password, mnemonic }, env);
    markBackedUp(dir, "phrase");

    const file = path.join(home, "wallet.key");
    const exported = runGnotx(gnotx, ["export", "-home", dir, "-key", "gpagent", "-out", file], { password, passphrase: "long test passphrase" }, env);
    check("export reports this wallet", exported.address === address);
    let refused = false;
    try {
      runGnotx(gnotx, ["export", "-home", dir, "-key", "gpagent", "-out", file], { password, passphrase: "long test passphrase" }, env);
    } catch {
      refused = true;
    }
    check("export does not replace a file", refused);

    await client.connect(new StdioClientTransport({ command: process.execPath, args: [LAUNCHER], env, stderr: "ignore" }));
    const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 })).content[0].text);
    const status = await call("gno_agent_status");
    check("the server runs this wallet", status.address === address, status.address);
    check("status reports the saved backup", status.recovery_backup === "saved", status.recovery_backup);
    fs.renameSync(backupMark(dir), `${backupMark(dir)}.moved`);
    const none = await call("gno_agent_status");
    check("status notices a missing backup while running", none.recovery_backup === "none", none.recovery_backup);
    check("status tells the user to run backup themselves", none.know_before_funding.some((l) => /in their own terminal/.test(l)));
    fs.renameSync(`${backupMark(dir)}.moved`, backupMark(dir));
    check("the old token file is gone", !fs.existsSync(path.join(dir, ".serve-token")));

    const sim = (await client.callTool({ name: "gno_simulate", arguments: { pkgpath: "gno.land/r/demo/x", func: "F", args: [] } }, undefined, { timeout: 60000 })).content[0].text;
    check("the signer accepts the piped token", /verify simulation network/.test(sim) && !/bearer token/.test(sim), sim.slice(0, 200));
    const resp = await fetch(`http://${addr}/simulate`, { method: "POST", headers: { Authorization: "Bearer wrong" }, body: "{}" });
    check("a wrong token is refused", resp.status === 401, String(resp.status));

    const lacking = new Client({ name: "real-signer-2", version: "1" });
    const noWallet = { ...env, GNOPULSE_AGENT_ID: "no-wallet", GNOPULSE_SIGNER_ADDR: "" };
    fs.mkdirSync(walletDir(env, "gnoland-1", "no-wallet"), { recursive: true });
    fs.writeFileSync(path.join(walletDir(env, "gnoland-1", "no-wallet"), ".pass"), password, { mode: 0o600 });
    await lacking.connect(new StdioClientTransport({ command: process.execPath, args: [LAUNCHER], env: noWallet, stderr: "ignore" }));
    const { tools } = await lacking.listTools();
    const hint = JSON.parse((await lacking.callTool({ name: "gno_agent_status", arguments: {} }, undefined, { timeout: 60000 })).content[0].text);
    await lacking.close();
    check("a folder with no key gets no write tools", !tools.some((t) => t.name === "gno_call"));
    check("status sends the user to setup", /npx @gnopulse\/mcp setup/.test(hint.next_steps[0]), hint.next_steps[0]);
    check("no wallet was created", !runGnotx(gnotx, ["keygen", "-home", walletDir(env, "gnoland-1", "no-wallet"), "-key", "gpagent", "-no-create", "-secrets-stdin"], { password }, env).address);

    if (process.platform !== "win32") {
      const lines = execSync("ps eww -A -o command", { maxBuffer: 1 << 26 }).toString().split("\n").filter((l) => l.includes(home));
      check("the signer and server are found in the process list", lines.length >= 2, String(lines.length));
      check("the process list really shows environments", lines.some((l) => l.includes("GNOPULSE_AGENT_ID=real")));
      check("no process shows a signer secret", !lines.some((l) => /GNOTX_(PASSWORD|SERVE_TOKEN|SERVICE_TOKEN)=/.test(l) || l.includes(password)));
    }
  } finally {
    await client.close().catch(() => {});
    rpc.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
