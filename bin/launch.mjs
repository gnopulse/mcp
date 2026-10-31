#!/usr/bin/env node
// `gnopulse-mcp` launcher. Resolves the gnotx signer binary, creates the agent key on first run,
// starts an isolated execution-disabled `gnotx serve` when an agent ID is configured,
// then runs the MCP server over stdio. Signing requires explicit configuration.
// The key stays in the signer process.
// stdout belongs to the MCP JSON-RPC stream, so this script logs only to stderr.
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(PKG_ROOT, "dist");
const MCP_ENTRY = path.join(DIST, "index.js");

const env = process.env;
const AGENT_ID = env.GNOPULSE_AGENT_ID;
const CHAIN_ID = env.GNO_CHAIN_ID || "gnoland-1";
const HOME_ROOT = env.GNOPULSE_AGENT_HOME || path.join(os.homedir(), ".gnopulse-agent");
const HOME_DIR = path.join(HOME_ROOT, "agents", CHAIN_ID, AGENT_ID || "unconfigured");
const SIGNER_KIND = env.GNOPULSE_SIGNER || "none";
const KEY_NAME = env.GNOPULSE_AGENT_KEY || "gpagent";
let signerAddr = env.GNOPULSE_SIGNER_ADDR;
const MAX_SEND = env.GNOPULSE_POLICY_MAX_SEND_UGNOT || "5000000";
const ALLOW_REALMS = env.GNOPULSE_POLICY_ALLOW_REALMS || "";
const SIGNER_LOG = path.join(HOME_DIR, "signer.log");

const PLATFORMS = { darwin: "darwin", linux: "linux", win32: "windows" };
const ARCHES = { arm64: "arm64", x64: "amd64" };

let ownedSigner;
let mcpChild;
let stopping = false;

// Each launcher owns an exclusive signer endpoint; it never adopts another client's process.
function cleanupSigner() {
  if (ownedSigner && ownedSigner.exitCode === null && ownedSigner.signalCode === null) {
    ownedSigner.kill("SIGTERM");
  }
}
process.on("exit", cleanupSigner);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    cleanupSigner();
    if (mcpChild) mcpChild.kill(signal);
    else process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

const log = (msg) => process.stderr.write(`[gnopulse-launch] ${msg}\n`);
const die = (msg) => {
  log(`fatal: ${msg}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRunnable(bin) {
  if (!bin || !fs.existsSync(bin)) return false;
  return !spawnSync(bin, ["-h"], { encoding: "utf8" }).error;
}

// GNOTX_BIN wins; otherwise use the platform package installed as an optional dependency.
function resolveGnotx() {
  if (env.GNOTX_BIN) {
    if (isRunnable(env.GNOTX_BIN)) return env.GNOTX_BIN;
    die(`GNOTX_BIN=${env.GNOTX_BIN} is not a runnable gnotx`);
  }
  const osName = PLATFORMS[process.platform];
  const arch = ARCHES[process.arch];
  if (!osName || !arch)
    die(`unsupported platform ${process.platform}/${process.arch}; set GNOTX_BIN to a gnotx you built`);

  const pkg = `@gnopulse/gnotx-${osName}-${arch}`;
  let bin;
  try {
    bin = path.join(
      path.dirname(require.resolve(`${pkg}/package.json`)),
      osName === "windows" ? "gnotx.exe" : "gnotx"
    );
  } catch {
    die(`${pkg} is not installed; reinstall @gnopulse/mcp or set GNOTX_BIN`);
  }
  if (!isRunnable(bin)) die(`signer at ${bin} is not runnable`);
  return bin;
}

// Read a secret from `file`, creating it (mode 0600) on first use.
function ensureSecret(file, length) {
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const secret = randomBytes(length)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, length);
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, secret, { mode: 0o600, flag: "wx" });
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    return fs.readFileSync(file, "utf8").trim();
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// The /healthz body of a signer listening on signerAddr, or null if none answers.
// Sends no token, so it is safe against an unknown process.
async function signerHealth() {
  try {
    const resp = await fetch(`http://${signerAddr}/healthz`, {
      signal: AbortSignal.timeout(2500)
    });
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  }
}

// Refuse a signer that signs for another key or chain; the session token must only reach ours.
function assertOwnSigner(health, address) {
  if (health.caller !== address) {
    die(
      `${signerAddr} is taken by another signer (caller ${health.caller ?? "unknown"}, expected ${address}). ` +
        "Stop it or set GNOPULSE_SIGNER_ADDR to a free port."
    );
  }
  if (health.chainid !== CHAIN_ID) {
    die(
      `signer on ${signerAddr} is on chain ${health.chainid ?? "unknown"}, expected ${CHAIN_ID}. Stop it and retry.`
    );
  }
}

function ensureKey(gnotx, password) {
  const result = spawnSync(gnotx, ["keygen", "-home", HOME_DIR, "-key", KEY_NAME], {
    encoding: "utf8",
    env: { ...env, GNOTX_PASSWORD: password }
  });
  if (result.status !== 0) die(`keygen failed: ${(result.stderr || result.stdout || "").trim()}`);
  let address;
  try {
    address = JSON.parse(result.stdout).address;
  } catch {
    die(`keygen output is not JSON: ${result.stdout}`);
  }
  if (!address) die("keygen returned no address");
  return address;
}

async function ensureSigner(gnotx, password, token, remotes, address) {
  const existing = await signerHealth();
  if (existing) {
    assertOwnSigner(existing, address);
    die(
      `signer already running on ${signerAddr}; choose a free GNOPULSE_SIGNER_ADDR. ` +
        "Launcher-owned signers cannot be shared between clients."
    );
  }
  log(`starting signer on ${signerAddr}`);
  const logFd = fs.openSync(SIGNER_LOG, "a");
  const args = [
    "serve",
    "-key",
    KEY_NAME,
    "-home",
    HOME_DIR,
    "-addr",
    signerAddr,
    "-remotes",
    remotes,
    "-chainid",
    CHAIN_ID
  ];
  if (SIGNER_KIND !== "none") args.push("-allow-execute");
  // Keep ownership so EOF, startup errors and signals can stop our signer.
  ownedSigner = spawn(gnotx, args, {
    stdio: ["ignore", logFd, logFd],
    env: {
      ...env,
      GNOTX_PASSWORD: password,
      GNOTX_SERVE_TOKEN: token,
      GNOTX_GAS_FEE: "auto"
    }
  });
  fs.closeSync(logFd);
  ownedSigner.on("error", () => die("could not start the signer"));
  ownedSigner.on("exit", () => {
    if (stopping) return;
    stopping = true;
    mcpChild?.kill("SIGTERM");
    die("owned signer exited; refusing to reuse another process on its endpoint");
  });

  for (let i = 0; i < 20; i++) {
    const health = await signerHealth();
    if (health) return assertOwnSigner(health, address);
    await sleep(500);
  }
  die(`signer did not start on ${signerAddr} (see ${SIGNER_LOG})`);
}

async function privateSignerAddress() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return `127.0.0.1:${port}`;
}

async function main() {
  if (!fs.existsSync(MCP_ENTRY)) die(`MCP server not built at ${MCP_ENTRY}`);
  if (!["none", "user-approval", "microservice", "tee"].includes(SIGNER_KIND))
    die("Unknown GNOPULSE_SIGNER mode.");
  if (!AGENT_ID && SIGNER_KIND !== "none") die("Set a distinct GNOPULSE_AGENT_ID before enabling signing.");
  if (AGENT_ID && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(AGENT_ID))
    die("GNOPULSE_AGENT_ID must be 1-64 lowercase letters, digits, underscores or hyphens.");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(CHAIN_ID)) die("Invalid GNO_CHAIN_ID for wallet storage.");
  if (!AGENT_ID && SIGNER_KIND === "none") {
    const child = spawn(process.execPath, [MCP_ENTRY], {
      stdio: "inherit",
      env
    });
    mcpChild = child;
    child.on("error", () => die("could not start the MCP server"));
    child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
    return;
  }
  if (SIGNER_KIND === "microservice" || SIGNER_KIND === "tee") {
    const { loadPolicy } = await import(pathToFileURL(path.join(DIST, "signer/policy.js")).href);
    const policy = loadPolicy(env);
    if (!policy.boundedAutonomy)
      die(
        "Autonomous signing (GNOPULSE_SIGNER=microservice) acts without asking, so it needs limits. Missing: " +
          `${policy.missingForAutonomy().join(", ")}. Example: GNOPULSE_POLICY_ALLOW_REALMS=gno.land/r/gnoland/wugnot ` +
          "GNOPULSE_POLICY_ALLOW_FUNCS=Deposit,Withdraw GNOPULSE_POLICY_MAX_SEND_UGNOT=1000000 " +
          "GNOPULSE_POLICY_MAX_FEE_UGNOT=1000000 GNOPULSE_POLICY_MAX_GAS=50000000 GNOPULSE_POLICY_EXPIRES_IN=86400. " +
          "Or set GNOPULSE_SIGNER=user-approval to approve each transaction instead."
      );
  }
  signerAddr ||= await privateSignerAddress();
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });

  const { DEFAULT_RPC_URLS } = await import(pathToFileURL(path.join(DIST, "config.js")).href);
  const remotes = env.GNO_RPC_URLS || DEFAULT_RPC_URLS.join(",");

  const gnotx = resolveGnotx();
  const password = ensureSecret(path.join(HOME_DIR, ".pass"), 24);
  const token = ensureSecret(path.join(HOME_DIR, ".serve-token"), 32);
  const address = ensureKey(gnotx, password);
  await ensureSigner(gnotx, password, token, remotes, address);

  log(
    `agent wallet: ${address} (agent ${AGENT_ID}, chain ${CHAIN_ID}, signing ${SIGNER_KIND}). ` +
      "Funding does not grant execution permission."
  );

  const mcp = spawn(process.execPath, [MCP_ENTRY], {
    stdio: "inherit",
    env: {
      ...env,
      GNOPULSE_SIGNER: SIGNER_KIND,
      GNOPULSE_AGENT_ADDRESS: address,
      GNOPULSE_POLICY_DEFAULT: env.GNOPULSE_POLICY_DEFAULT || (ALLOW_REALMS ? "deny" : "allow"),
      GNOPULSE_POLICY_ALLOW_REALMS: ALLOW_REALMS,
      GNOPULSE_POLICY_MAX_SEND_UGNOT: MAX_SEND,
      GNO_CHAIN_ID: CHAIN_ID,
      GNOTX_SERVICE_URL: `http://${signerAddr}`,
      GNOTX_SERVICE_TOKEN: token
    }
  });
  mcpChild = mcp;
  mcp.on("error", () => die("could not start the MCP server"));
  mcp.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}

if (process.argv[2] === "setup") await import("./setup.mjs");
else main().catch((e) => die(e?.stack || String(e)));
