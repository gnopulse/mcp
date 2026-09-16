// Launcher: reuses only a signer for its own key and chain, never sends the session token to
// an unverified process, and starts `gnotx serve` with the chain id. Uses a fake gnotx.
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, freePort, run, serverEnv, startMock } from "./lib.mjs";

const LAUNCHER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/launch.mjs");
const AGENT = "g1agentaddress";

// keygen prints the agent address; serve records its argv and answers /healthz.
const FAKE_GNOTX = `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const [cmd, ...args] = process.argv.slice(2);
if (cmd === "keygen") console.log(JSON.stringify({ name: "gpagent", address: "${AGENT}", created: false }));
if (cmd === "serve") {
  const flag = (name) => args[args.indexOf(name) + 1];
  fs.writeFileSync(process.env.FAKE_SERVE_LOG, JSON.stringify({ pid: process.pid, args }));
  const [host, port] = flag("-addr").split(":");
  http
    .createServer((_, res) => res.end(JSON.stringify({ ok: true, caller: "${AGENT}", chainid: flag("-chainid") })))
    .listen(Number(port), host);
}
`;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gnopulse-launch-"));
  const bin = path.join(dir, "gnotx.cjs");
  fs.writeFileSync(bin, FAKE_GNOTX, { mode: 0o755 });
  return { dir, bin, serveLog: path.join(dir, "serve.json") };
}

/** Run the launcher until it exits or logs `until`, then stop it. */
async function launch(env, until) {
  const child = spawn(process.execPath, [LAUNCHER], { stdio: ["pipe", "ignore", "pipe"], env });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
    if (until.test(stderr)) child.kill("SIGTERM");
  });
  const [code] = await once(child, "exit");
  return { code, stderr };
}

await run(async () => {
  const { dir, bin, serveLog } = setup();
  const baseEnv = (addr, extra = {}) =>
    serverEnv({ GNOTX_BIN: bin, GNOPULSE_AGENT_HOME: dir, GNOPULSE_SIGNER_ADDR: addr, FAKE_SERVE_LOG: serveLog, ...extra });

  try {
    const authHeaders = [];
    const other = await startMock((req) => {
      authHeaders.push(req.headers.authorization);
      return { ok: true, caller: "g1someoneelse", chainid: "gnoland-1" };
    });
    const otherAddr = other.url.replace("http://", "");
    const taken = await launch(baseEnv(otherAddr), /agent wallet/);
    check("foreign signer on the port is refused", taken.code === 1 && /taken by another signer/.test(taken.stderr), taken.stderr.trim());
    check("no token is sent to the foreign signer", authHeaders.every((h) => h === undefined), String(authHeaders));
    other.close();

    const wrongChain = await startMock(() => ({ ok: true, caller: AGENT, chainid: "test13" }));
    const chainRun = await launch(baseEnv(wrongChain.url.replace("http://", "")), /agent wallet/);
    check("own signer on another chain is refused", chainRun.code === 1 && /expected gnoland-1/.test(chainRun.stderr), chainRun.stderr.trim());
    wrongChain.close();

    const addr = `127.0.0.1:${await freePort()}`;
    const started = await launch(baseEnv(addr, { GNO_CHAIN_ID: "test13" }), /agent wallet/);
    const serve = JSON.parse(fs.readFileSync(serveLog, "utf8"));
    try {
      process.kill(serve.pid);
    } catch {}
    const args = serve.args.join(" ");
    check("serve gets -chainid from GNO_CHAIN_ID", /-chainid test13/.test(args), args);
    check("serve is not passed -broadcast", !serve.args.includes("-broadcast"), args);
    check("startup log prints the chain id", /agent wallet: g1agentaddress \(chain test13\)/.test(started.stderr), started.stderr.trim());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
