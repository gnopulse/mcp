// Pure helpers for `gnopulse-mcp setup`: what each choice means, and how each app stores MCP servers.
import os from "node:os";
import path from "node:path";

export const NETWORKS = {
  mainnet: { label: "gno.land mainnet (real GNOT)", env: {} },
  onyx: {
    label: "Onyx testnet (free test GNOT)",
    env: {
      GNO_CHAIN_ID: "onyx-1",
      GNO_RPC_URLS: "https://rpc.onyx.testnets.gno.land",
      GNOPULSE_API_BASE: "https://gnopulse.xyz/onyx",
      GNO_GRC20_REGISTRY: "gno.land/r/nt/grc20reg/v0"
    }
  }
};

export const MODES = {
  data: { label: "Data only: read and simulate, never sign", signer: "none" },
  approval: { label: "Approve each transaction: you confirm every one", signer: "user-approval" },
  autonomous: { label: "Autonomous: acts without asking, inside limits you set", signer: "microservice" }
};

/** Autonomous presets. Fee and gas caps cover the largest call in the preset, including storage. */
export const PRESETS = {
  wrap: {
    label: "Wrap and unwrap GNOT (wugnot)",
    realms: ["gno.land/r/gnoland/wugnot"],
    funcs: ["Deposit", "Withdraw"],
    maxFeeUgnot: 1_000_000,
    maxGas: 50_000_000
  },
  swap: {
    label: "Trade GNOT and GNS on GnoSwap (wrap, approve, swap)",
    realms: ["gno.land/r/gnoland/wugnot", "gno.land/r/gnoswap/router", "gno.land/r/gnoswap/gns"],
    funcs: ["Deposit", "Withdraw", "Approve", "ExactInSwapRoute"],
    maxFeeUgnot: 3_000_000,
    maxGas: 300_000_000
  }
};

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validAgentId(id) {
  return ID_RE.test(id);
}

/** GNOT as typed ("1", "0.5") to ugnot; null when it is not a positive amount with at most 6 decimals. */
export function gnotToUgnot(text) {
  const m = String(text).trim().match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!m) return null;
  const ugnot = BigInt(m[1]) * 1_000_000n + BigInt((m[2] || "").padEnd(6, "0"));
  return ugnot > 0n ? ugnot.toString() : null;
}

/**
 * The server env for the answers. Autonomous grants get an absolute expiry, so restarting the app
 * does not renew them.
 */
export function buildEnv(a, nowSeconds = Math.floor(Date.now() / 1000)) {
  const env = { ...NETWORKS[a.network].env };
  if (a.apiKey) env.GNOPULSE_API_KEY = a.apiKey;
  if (a.mode !== "data" || a.agentId) env.GNOPULSE_AGENT_ID = a.agentId;
  env.GNOPULSE_SIGNER = MODES[a.mode].signer;
  if (a.mode === "autonomous") {
    const p = PRESETS[a.preset];
    env.GNOPULSE_POLICY_DEFAULT = "deny";
    env.GNOPULSE_POLICY_ALLOW_REALMS = p.realms.join(",");
    env.GNOPULSE_POLICY_ALLOW_FUNCS = p.funcs.join(",");
    env.GNOPULSE_POLICY_MAX_SEND_UGNOT = a.maxSendUgnot;
    env.GNOPULSE_POLICY_MAX_FEE_UGNOT = String(p.maxFeeUgnot);
    env.GNOPULSE_POLICY_MAX_GAS = String(p.maxGas);
    env.GNOPULSE_POLICY_EXPIRES_AT = String(nowSeconds + Math.round(a.hours * 3600));
  }
  return env;
}

/** A server entry that GUI apps can start: absolute npx, pinned package version. */
export function serverEntry(env, npx, version) {
  return { command: npx, args: ["-y", `@gnopulse/mcp@${version}`], env };
}

/** Where each app keeps its MCP servers, and in which shape. */
export function appTargets(platform = process.platform, home = os.homedir(), appData = process.env.APPDATA) {
  const support =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : platform === "win32"
        ? appData || path.join(home, "AppData", "Roaming")
        : path.join(home, ".config");
  return {
    "claude-code": { label: "Claude Code", kind: "claude-cli" },
    codex: { label: "Codex", kind: "toml", file: path.join(home, ".codex", "config.toml") },
    cursor: { label: "Cursor", kind: "json", key: "mcpServers", file: path.join(home, ".cursor", "mcp.json") },
    vscode: { label: "VS Code", kind: "json", key: "servers", file: path.join(support, "Code", "User", "mcp.json") },
    "claude-desktop": {
      label: "Claude Desktop",
      kind: "json",
      key: "mcpServers",
      file: path.join(support, "Claude", "claude_desktop_config.json")
    },
    print: { label: "None: print the config to copy", kind: "print" }
  };
}

/** Names of servers in an app config that run @gnopulse/mcp, other than `except`. */
export function otherGnopulseServers(target, text, except) {
  if (!text) return [];
  if (target.kind === "toml") {
    const names = [...text.matchAll(/^\[mcp_servers\.([^\].]+)\]/gm)].map((m) => m[1]);
    return names.filter((n) => n !== except && sectionOf(text, n).includes("@gnopulse/mcp"));
  }
  const servers = JSON.parse(text)[target.key] || {};
  return Object.keys(servers).filter((n) => n !== except && JSON.stringify(servers[n]).includes("@gnopulse/mcp"));
}

export function hasServer(target, text, name) {
  if (!text) return false;
  if (target.kind === "toml") return new RegExp(`^\\[mcp_servers\\.${escapeRe(name)}\\]`, "m").test(text);
  return Object.prototype.hasOwnProperty.call(JSON.parse(text)[target.key] || {}, name);
}

/** The JSON config text with `name` set to `entry`; every other key is kept. */
export function applyJson(text, key, name, entry) {
  const config = text && text.trim() ? JSON.parse(text) : {};
  config[key] = { ...(config[key] || {}), [name]: key === "servers" ? { type: "stdio", ...entry } : entry };
  return JSON.stringify(config, null, 2) + "\n";
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tomlString = (s) => JSON.stringify(String(s));

function sectionOf(text, name) {
  const re = new RegExp(`^\\[mcp_servers\\.${escapeRe(name)}(?:\\.[^\\]]+)?\\]$`);
  const lines = text.split("\n");
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) inside = re.test(line.trim());
    if (inside) out.push(line);
  }
  return out.join("\n");
}

/** The Codex TOML with `name` replaced by `entry`; other sections and comments are kept. */
export function applyToml(text, name, entry) {
  const re = new RegExp(`^\\[mcp_servers\\.${escapeRe(name)}(?:\\.[^\\]]+)?\\]$`);
  const kept = [];
  let inside = false;
  for (const line of (text || "").split("\n")) {
    if (/^\s*\[/.test(line)) inside = re.test(line.trim());
    if (!inside) kept.push(line);
  }
  const body = kept.join("\n").replace(/\n+$/, "");
  const block = [
    `[mcp_servers.${name}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`,
    "startup_timeout_sec = 60",
    "tool_timeout_sec = 360",
    "",
    `[mcp_servers.${name}.env]`,
    ...Object.entries(entry.env).map(([k, v]) => `${k} = ${tomlString(v)}`)
  ].join("\n");
  return (body ? body + "\n\n" : "") + block + "\n";
}

/** What people should know before they fund the wallet. Shown at the end of setup. */
export const BEFORE_YOU_FUND = [
  "Fund the agent wallet like a prepaid card: only what you are willing to lose.",
  "Limits are per transaction, not daily budgets, and the send cap covers GNOT only, not other tokens.",
  "Limits bind the GnoPulse tools. An agent with unrestricted shell access on this computer could read the",
  "  wallet key in ~/.gnopulse-agent, so keep your app's approval for file edits and shell commands on.",
  "Web chat apps (claude.ai, ChatGPT on the web) cannot use an agent wallet; they reach only the hosted,",
  "  read-only server. Claude's chat apps may decline to make transactions; Claude Code does not.",
  "To change what the agent may do later, run setup again or edit the server's settings, then restart the app."
];
