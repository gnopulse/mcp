#!/usr/bin/env node
// `gnopulse-mcp` launcher. Resolves the gnotx signer binary, starts an isolated execution-disabled
// `gnotx serve` for an existing agent wallet, then runs the MCP server over stdio. Wallets come from
// `setup`, which saves the recovery phrase first; with none, the server runs with data tools only.
// Signing requires explicit configuration.
// The key stays in the signer process.
// stdout belongs to the MCP JSON-RPC stream, so this script logs only to stderr.
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  backupMark,
  ensureSecret,
  keyName,
  randomSecret,
  resolveGnotx,
  runGnotx,
  secretLine,
  walletDir,
  withoutSecrets,
  withoutSignerKeys
} from "./wallet-lib.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(PKG_ROOT, "dist");
const MCP_ENTRY = path.join(DIST, "index.js");

const env = process.env;
const AGENT_ID = env.GNOPULSE_AGENT_ID;
const CHAIN_ID = env.GNO_CHAIN_ID || "gnoland-1";
const HOME_DIR = walletDir(env, CHAIN_ID, AGENT_ID || "unconfigured");
const SIGNER_KIND = env.GNOPULSE_SIGNER || "none";
const KEY_NAME = keyName(env);
let signerAddr = env.GNOPULSE_SIGNER_ADDR;
const MAX_SEND = env.GNOPULSE_POLICY_MAX_SEND_UGNOT || "5000000";
const ALLOW_REALMS = env.GNOPULSE_POLICY_ALLOW_REALMS || "";
const SIGNER_LOG = path.join(HOME_DIR, "signer.log");

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
  let address;
  try {
    address = runGnotx(gnotx, ["keygen", "-home", HOME_DIR, "-key", KEY_NAME, "-secrets-stdin"], { password }, env).address;
  } catch (e) {
    die(`keygen failed: ${e.message}`);
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
    CHAIN_ID,
    "-secrets-stdin"
  ];
  if (SIGNER_KIND !== "none") args.push("-allow-execute");
  // Keep ownership so EOF, startup errors and signals can stop our signer.
  ownedSigner = spawn(gnotx, args, {
    stdio: ["pipe", logFd, logFd],
    env: { ...withoutSecrets(env), GNOTX_GAS_FEE: "auto" }
  });
  fs.closeSync(logFd);
  ownedSigner.stdin?.on("error", () => {});
  ownedSigner.stdin?.end(secretLine({ password, serve_token: token }));
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

function startServer(childEnv) {
  const child = spawn(process.execPath, [MCP_ENTRY], { stdio: "inherit", env: childEnv });
  mcpChild = child;
  child.on("error", () => die("could not start the MCP server"));
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}

// No wallet yet, so no signer: the data tools work and the status tells the user to run setup.
function startWithoutWallet() {
  log(`agent ${AGENT_ID} has no wallet on chain ${CHAIN_ID}, so signing is off. Run: npx @gnopulse/mcp setup`);
  const childEnv = { ...withoutSignerKeys(env), GNOPULSE_SIGNER: "none", GNOPULSE_WALLET_SETUP_NEEDED: "1", GNO_CHAIN_ID: CHAIN_ID };
  for (const name of ["GNOTX_SERVICE_URL", "GNOPULSE_AGENT_ADDRESS"]) delete childEnv[name];
  startServer(childEnv);
}

async function main() {
  if (!fs.existsSync(MCP_ENTRY)) die(`MCP server not built at ${MCP_ENTRY}`);
  if (!["none", "user-approval", "microservice", "tee"].includes(SIGNER_KIND))
    die("Unknown GNOPULSE_SIGNER mode.");
  if (!AGENT_ID && SIGNER_KIND !== "none") die("Set a distinct GNOPULSE_AGENT_ID before enabling signing.");
  if (AGENT_ID && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(AGENT_ID))
    die("GNOPULSE_AGENT_ID must be 1-64 lowercase letters, digits, underscores or hyphens.");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(CHAIN_ID)) die("Invalid GNO_CHAIN_ID for wallet storage.");
  if (!AGENT_ID && SIGNER_KIND === "none") return startServer(env);
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
  const passFile = path.join(HOME_DIR, ".pass");
  let gnotx;
  try {
    // A folder with no .pass has no wallet, and the data tools need no signer binary.
    if (env.GNOPULSE_ALLOW_NO_BACKUP !== "1" && !fs.existsSync(passFile)) return startWithoutWallet();
    gnotx = resolveGnotx(env);
    if (env.GNOPULSE_ALLOW_NO_BACKUP !== "1") {
      const args = ["keygen", "-home", HOME_DIR, "-key", KEY_NAME, "-no-create", "-secrets-stdin"];
      const password = fs.readFileSync(passFile, "utf8").trim();
      if (!runGnotx(gnotx, args, { password }, env).address) return startWithoutWallet();
    }
  } catch (e) {
    die(e.message);
  }
  signerAddr ||= await privateSignerAddress();
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });

  const { DEFAULT_RPC_URLS } = await import(pathToFileURL(path.join(DIST, "config.js")).href);
  const remotes = env.GNO_RPC_URLS || DEFAULT_RPC_URLS.join(",");

  const password = ensureSecret(passFile, 24);
  // A fresh token each launch, held only by this launcher's two children. Earlier versions saved it.
  const token = randomSecret(32);
  fs.rmSync(path.join(HOME_DIR, ".serve-token"), { force: true });
  const address = ensureKey(gnotx, password);
  await ensureSigner(gnotx, password, token, remotes, address);

  log(
    `agent wallet: ${address} (agent ${AGENT_ID}, chain ${CHAIN_ID}, signing ${SIGNER_KIND}). ` +
      "Funding does not grant execution permission."
  );

  const mcp = spawn(process.execPath, [MCP_ENTRY], {
    stdio: ["inherit", "inherit", "inherit", "pipe"],
    env: {
      ...withoutSignerKeys(env),
      GNOPULSE_SIGNER: SIGNER_KIND,
      GNOPULSE_AGENT_ADDRESS: address,
      GNOPULSE_POLICY_DEFAULT: env.GNOPULSE_POLICY_DEFAULT || (ALLOW_REALMS ? "deny" : "allow"),
      GNOPULSE_POLICY_ALLOW_REALMS: ALLOW_REALMS,
      GNOPULSE_POLICY_MAX_SEND_UGNOT: MAX_SEND,
      GNO_CHAIN_ID: CHAIN_ID,
      GNOTX_SERVICE_URL: `http://${signerAddr}`,
      GNOTX_SERVICE_TOKEN_FD: "3",
      GNOPULSE_WALLET_BACKUP_MARK: backupMark(HOME_DIR)
    }
  });
  mcp.stdio?.[3]?.on("error", () => {});
  mcp.stdio?.[3]?.end(token);
  mcpChild = mcp;
  mcp.on("error", () => die("could not start the MCP server"));
  mcp.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}

if (process.argv[2] === "setup") await import("./setup.mjs");
else if (process.argv[2] === "backup") await import("./backup.mjs");
else main().catch((e) => die(e?.stack || String(e)));
