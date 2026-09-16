#!/usr/bin/env node
// `gnopulse-mcp` launcher. Resolves the gnotx signer binary, creates the agent key on first run,
// starts `gnotx serve` if it is not already running, then runs the MCP server over stdio with
// human approval required for every write. The key stays in the signer process.
// stdout belongs to the MCP JSON-RPC stream, so this script logs only to stderr.
import { spawn, spawnSync } from "node:child_process";
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
const HOME_DIR = env.GNOPULSE_AGENT_HOME || path.join(os.homedir(), ".gnopulse-agent");
const KEY_NAME = env.GNOPULSE_AGENT_KEY || "gpagent";
const SIGNER_ADDR = env.GNOPULSE_SIGNER_ADDR || "127.0.0.1:8899";
const CHAIN_ID = env.GNO_CHAIN_ID || "gnoland-1";
const MAX_SEND = env.GNOPULSE_POLICY_MAX_SEND_UGNOT || "5000000";
const ALLOW_REALMS = env.GNOPULSE_POLICY_ALLOW_REALMS || "";
const SIGNER_LOG = path.join(HOME_DIR, "signer.log");

const PLATFORMS = { darwin: "darwin", linux: "linux", win32: "windows" };
const ARCHES = { arm64: "arm64", x64: "amd64" };

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
  if (!osName || !arch) die(`unsupported platform ${process.platform}/${process.arch}; set GNOTX_BIN to a gnotx you built`);

  const pkg = `@gnopulse/gnotx-${osName}-${arch}`;
  let bin;
  try {
    bin = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), osName === "windows" ? "gnotx.exe" : "gnotx");
  } catch {
    die(`${pkg} is not installed; reinstall @gnopulse/mcp or set GNOTX_BIN`);
  }
  if (!isRunnable(bin)) die(`signer at ${bin} is not runnable`);
  return bin;
}

// Read a secret from `file`, creating it (mode 0600) on first use.
function ensureSecret(file, length) {
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const secret = randomBytes(length).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, length);
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

// The /healthz body of a signer listening on SIGNER_ADDR, or null if none answers.
// Sends no token, so it is safe against an unknown process.
async function signerHealth() {
  try {
    const resp = await fetch(`http://${SIGNER_ADDR}/healthz`, { signal: AbortSignal.timeout(2500) });
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  }
}

// Refuse a signer that signs for another key or chain; the session token must only reach ours.
function assertOwnSigner(health, address) {
  if (health.caller !== address) {
    die(
      `${SIGNER_ADDR} is taken by another signer (caller ${health.caller ?? "unknown"}, expected ${address}). ` +
        "Stop it or set GNOPULSE_SIGNER_ADDR to a free port.",
    );
  }
  if (health.chainid !== CHAIN_ID) {
    die(`signer on ${SIGNER_ADDR} is on chain ${health.chainid ?? "unknown"}, expected ${CHAIN_ID}. Stop it and retry.`);
  }
}

function ensureKey(gnotx, password) {
  const result = spawnSync(gnotx, ["keygen", "-home", HOME_DIR, "-key", KEY_NAME], {
    encoding: "utf8",
    env: { ...env, GNOTX_PASSWORD: password },
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
    log(`signer already running on ${SIGNER_ADDR}`);
    return;
  }
  log(`starting signer on ${SIGNER_ADDR}`);
  const logFd = fs.openSync(SIGNER_LOG, "a");
  const args = ["serve", "-key", KEY_NAME, "-home", HOME_DIR, "-addr", SIGNER_ADDR, "-remotes", remotes, "-chainid", CHAIN_ID];
  // Detached so the signer outlives MCP client restarts.
  spawn(gnotx, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...env, GNOTX_PASSWORD: password, GNOTX_SERVE_TOKEN: token, GNOTX_GAS_FEE: "auto" },
  }).unref();

  for (let i = 0; i < 20; i++) {
    const health = await signerHealth();
    if (health) return assertOwnSigner(health, address);
    await sleep(500);
  }
  die(`signer did not start on ${SIGNER_ADDR} (see ${SIGNER_LOG})`);
}

async function main() {
  if (!fs.existsSync(MCP_ENTRY)) die(`MCP server not built at ${MCP_ENTRY}`);
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });

  const { DEFAULT_RPC_URLS } = await import(pathToFileURL(path.join(DIST, "config.js")).href);
  const remotes = env.GNO_RPC_URLS || DEFAULT_RPC_URLS.join(",");

  const gnotx = resolveGnotx();
  const password = ensureSecret(path.join(HOME_DIR, ".pass"), 24);
  const token = ensureSecret(path.join(HOME_DIR, ".serve-token"), 32);
  const address = ensureKey(gnotx, password);
  await ensureSigner(gnotx, password, token, remotes, address);

  log(
    `agent wallet: ${address} (chain ${CHAIN_ID}). Fund it with GNOT to let the agent transact; ` +
      "each write is previewed and waits for your confirmation.",
  );

  const mcp = spawn(process.execPath, [MCP_ENTRY], {
    stdio: "inherit",
    env: {
      ...env,
      GNOPULSE_SIGNER: env.GNOPULSE_SIGNER || "user-approval",
      GNOPULSE_POLICY_DEFAULT: ALLOW_REALMS ? "deny" : "allow",
      GNOPULSE_POLICY_ALLOW_REALMS: ALLOW_REALMS,
      GNOPULSE_POLICY_MAX_SEND_UGNOT: MAX_SEND,
      GNO_CHAIN_ID: CHAIN_ID,
      GNOTX_SERVICE_URL: `http://${SIGNER_ADDR}`,
      GNOTX_SERVICE_TOKEN: token,
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => mcp.kill(signal));
  }
  mcp.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}

main().catch((e) => die(e?.stack || String(e)));
