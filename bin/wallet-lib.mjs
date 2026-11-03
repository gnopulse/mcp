// What the launcher, setup and backup share: where a wallet lives, its secrets and the signer binary.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PLATFORMS = { darwin: "darwin", linux: "linux", win32: "windows" };
const ARCHES = { arm64: "arm64", x64: "amd64" };
const BACKUP_MARK = ".recovery-backup";

export const homeRoot = (env) => env.GNOPULSE_AGENT_HOME || path.join(os.homedir(), ".gnopulse-agent");
export const walletDir = (env, chainId, agentId) => path.join(homeRoot(env), "agents", chainId, agentId);
export const keyName = (env) => env.GNOPULSE_AGENT_KEY || "gpagent";

function isRunnable(bin) {
  if (!bin || !fs.existsSync(bin)) return false;
  return !spawnSync(bin, ["-h"], { encoding: "utf8" }).error;
}

/** GNOTX_BIN wins; otherwise the platform package installed as an optional dependency. Throws if neither runs. */
export function resolveGnotx(env) {
  if (env.GNOTX_BIN) {
    if (isRunnable(env.GNOTX_BIN)) return env.GNOTX_BIN;
    throw new Error(`GNOTX_BIN=${env.GNOTX_BIN} is not a runnable gnotx`);
  }
  const osName = PLATFORMS[process.platform];
  const arch = ARCHES[process.arch];
  if (!osName || !arch)
    throw new Error(`unsupported platform ${process.platform}/${process.arch}; set GNOTX_BIN to a gnotx you built`);

  const pkg = `@gnopulse/gnotx-${osName}-${arch}`;
  let bin;
  try {
    bin = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), osName === "windows" ? "gnotx.exe" : "gnotx");
  } catch {
    throw new Error(`${pkg} is not installed; reinstall @gnopulse/mcp or set GNOTX_BIN`);
  }
  if (!isRunnable(bin)) throw new Error(`signer at ${bin} is not runnable`);
  return bin;
}

export function randomSecret(length) {
  return randomBytes(length * 2)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, length);
}

/** Read a secret from `file`, creating it (mode 0600) on first use. */
export function ensureSecret(file, length) {
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, randomSecret(length), { mode: 0o600, flag: "wx" });
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

/** The environment for a child, without any signer secret this process may have inherited. */
export function withoutSecrets(env) {
  const clean = { ...env };
  for (const name of ["GNOTX_PASSWORD", "GNOTX_SERVE_TOKEN", "GNOTX_SERVICE_TOKEN"]) delete clean[name];
  return clean;
}

/** The environment for the MCP server, which never needs an external signer's credentials. */
export function withoutSignerKeys(env) {
  const clean = withoutSecrets(env);
  for (const name of ["GNOTX_TEE_MNEMONIC", "TURNKEY_API_PRIVATE_KEY"]) delete clean[name];
  return clean;
}

/** A path as typed, with a leading ~ meaning the home folder. */
export const expandHome = (typed) => (/^~([/\\]|$)/.test(typed) ? path.join(os.homedir(), typed.slice(1)) : typed);

/** One JSON line for gnotx -secrets-stdin. */
export const secretLine = (secrets) => `${JSON.stringify(secrets)}\n`;

/** Run a one-shot gnotx command with secrets on stdin, and return its JSON. Throws without echoing its input. */
export function runGnotx(gnotx, args, secrets, env) {
  const result = spawnSync(gnotx, args, {
    encoding: "utf8",
    input: secrets ? secretLine(secrets) : "",
    env: withoutSecrets(env)
  });
  if (result.error) throw new Error(`could not run the signer: ${result.error.message}`);
  let out;
  try {
    out = JSON.parse(result.stdout);
  } catch {
    out = null;
  }
  if (result.status !== 0 || !out) {
    if (out?.error) throw new Error(out.error);
    const first = (result.stderr || "the signer failed").trim().split("\n")[0];
    throw new Error(`${first}${env.GNOTX_BIN ? " (GNOTX_BIN must be gnotx 0.3.9 or newer)" : ""}`);
  }
  return out;
}

export const backupMark = (dir) => path.join(dir, BACKUP_MARK);
export const backedUp = (dir) => fs.existsSync(backupMark(dir));

/** Record that the user saved a backup. It holds only how, and is a reminder rather than proof. */
export function markBackedUp(dir, how) {
  fs.writeFileSync(backupMark(dir), `${how} ${new Date().toISOString()}\n`, { mode: 0o600 });
}

/** Every wallet under the home root, as { chain, agent, dir }. */
export function listWallets(env) {
  const root = path.join(homeRoot(env), "agents");
  const dirs = (p) => (fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
  return dirs(root).flatMap((chain) =>
    dirs(path.join(root, chain))
      .filter((agent) => fs.existsSync(path.join(root, chain, agent, ".pass")))
      .map((agent) => ({ chain, agent, dir: path.join(root, chain, agent) }))
  );
}

/** Two different word positions (1-based) to ask for, in order. */
export function checkPositions(count, random = Math.random) {
  const first = Math.floor(random() * count);
  let second = Math.floor(random() * (count - 1));
  if (second >= first) second += 1;
  return [first + 1, second + 1].sort((a, b) => a - b);
}

export const sameWord = (typed, word) => typed.trim().toLowerCase() === word;
