// Setup writes only its own server into each app's settings, keeps everything else, and turns
// answers into limits that do not renew when the app restarts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appTargets,
  applyJson,
  applyToml,
  buildEnv,
  gnotToUgnot,
  hasServer,
  otherGnopulseServers,
  serverEntry
} from "../bin/setup-lib.mjs";

const entry = serverEntry({ GNOPULSE_SIGNER: "user-approval", GNOPULSE_AGENT_ID: "a" }, "/usr/local/bin/npx", "0.3.8");

test("amounts are typed in GNOT and stored in ugnot", () => {
  assert.equal(gnotToUgnot("1"), "1000000");
  assert.equal(gnotToUgnot("0.5"), "500000");
  assert.equal(gnotToUgnot("0.000001"), "1");
  for (const bad of ["0", "-1", "1.0000001", "abc", ""]) assert.equal(gnotToUgnot(bad), null, bad);
});

test("autonomous answers become every required limit, with an absolute expiry", () => {
  const env = buildEnv({ network: "onyx", mode: "autonomous", agentId: "bot", preset: "wrap", maxSendUgnot: "1000000", hours: 24, apiKey: "k" }, 1000);
  assert.equal(env.GNOPULSE_SIGNER, "microservice");
  assert.equal(env.GNO_CHAIN_ID, "onyx-1");
  assert.equal(env.GNOPULSE_POLICY_ALLOW_REALMS, "gno.land/r/gnoland/wugnot");
  assert.equal(env.GNOPULSE_POLICY_ALLOW_FUNCS, "Deposit,Withdraw");
  assert.equal(env.GNOPULSE_POLICY_EXPIRES_AT, String(1000 + 86400));
  assert.equal(env.GNOPULSE_POLICY_EXPIRES_IN, undefined);
  for (const k of ["MAX_SEND_UGNOT", "MAX_FEE_UGNOT", "MAX_GAS"]) assert.ok(env[`GNOPULSE_POLICY_${k}`], k);
});

test("data-only mode creates no wallet and approval mode adds no limits", () => {
  const data = buildEnv({ network: "mainnet", mode: "data" });
  assert.deepEqual(data, { GNOPULSE_SIGNER: "none" });
  const approval = buildEnv({ network: "mainnet", mode: "approval", agentId: "me" });
  assert.deepEqual(approval, { GNOPULSE_AGENT_ID: "me", GNOPULSE_SIGNER: "user-approval" });
});

test("JSON apps keep their other settings and servers", () => {
  const before = JSON.stringify({ preferences: { theme: "dark" }, mcpServers: { other: { command: "x" } } });
  const after = JSON.parse(applyJson(before, "mcpServers", "gnopulse", entry));
  assert.deepEqual(after.preferences, { theme: "dark" });
  assert.deepEqual(after.mcpServers.other, { command: "x" });
  assert.deepEqual(after.mcpServers.gnopulse, entry);
  assert.equal(JSON.parse(applyJson("", "servers", "gnopulse", entry)).servers.gnopulse.type, "stdio");
});

test("Codex TOML replaces only its own server and keeps the rest", () => {
  const before = [
    "# my settings",
    'model = "gpt"',
    "",
    "[mcp_servers.gnopulse]",
    'command = "old"',
    "",
    "[mcp_servers.gnopulse.env]",
    'GNOPULSE_SIGNER = "none"',
    "",
    "[mcp_servers.other]",
    'command = "keep"'
  ].join("\n");
  const after = applyToml(before, "gnopulse", entry);
  assert.match(after, /^# my settings\nmodel = "gpt"/);
  assert.match(after, /\[mcp_servers\.other\]\ncommand = "keep"/);
  assert.doesNotMatch(after, /command = "old"/);
  assert.match(after, /\[mcp_servers\.gnopulse\]\ncommand = "\/usr\/local\/bin\/npx"\nargs = \["-y", "@gnopulse\/mcp@0\.3\.8"\]/);
  assert.match(after, /\[mcp_servers\.gnopulse\.env\]\nGNOPULSE_SIGNER = "user-approval"\nGNOPULSE_AGENT_ID = "a"\n$/);
  assert.equal(after.match(/\[mcp_servers\.gnopulse\]/g).length, 1);
});

test("existing GnoPulse servers are found, so setup can warn about OpenAI's tool limit", () => {
  const codex = appTargets("darwin", "/h").codex;
  const toml = applyToml(applyToml("", "gp_a", entry), "plain", { command: "x", args: [], env: {} });
  assert.deepEqual(otherGnopulseServers(codex, toml, "gnopulse"), ["gp_a"]);
  assert.ok(hasServer(codex, toml, "plain"));
  const cursor = appTargets("darwin", "/h").cursor;
  assert.deepEqual(otherGnopulseServers(cursor, applyJson("", "mcpServers", "gp_b", entry), "gnopulse"), ["gp_b"]);
});

test("each app's settings file is where the app reads it", () => {
  const mac = appTargets("darwin", "/Users/u");
  assert.equal(mac.codex.file, "/Users/u/.codex/config.toml");
  assert.equal(mac["claude-desktop"].file, "/Users/u/Library/Application Support/Claude/claude_desktop_config.json");
  assert.equal(mac.vscode.file, "/Users/u/Library/Application Support/Code/User/mcp.json");
  assert.equal(appTargets("linux", "/home/u").cursor.file, "/home/u/.cursor/mcp.json");
});

test("a local test package runs through npx --package and its bin", () => {
  assert.deepEqual(serverEntry({}, "npx", "0.3.8", "/tmp/gnopulse-mcp-0.3.8.tgz").args, ["-y", "--package", "/tmp/gnopulse-mcp-0.3.8.tgz", "gnopulse-mcp"]);
  assert.deepEqual(serverEntry({}, "npx", "0.3.8").args, ["-y", "@gnopulse/mcp@0.3.8"]);
});
