// `npx @gnopulse/mcp setup`: asks what the agent may do, writes it into the chosen app's MCP
// settings (after showing it and backing the file up), then creates the wallet and shows its address.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  BEFORE_YOU_FUND,
  MODES,
  NETWORKS,
  PRESETS,
  appTargets,
  applyJson,
  applyToml,
  buildEnv,
  gnotToUgnot,
  hasServer,
  otherGnopulseServers,
  serverEntry,
  validAgentId
} from "./setup-lib.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = require("../package.json").version;
const say = (line = "") => process.stdout.write(line + "\n");

if (!process.stdin.isTTY) {
  say("Run `npx @gnopulse/mcp setup` in a terminal; it asks a few questions.");
  process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function choose(question, options) {
  const keys = Object.keys(options);
  say(question);
  keys.forEach((k, i) => say(`  ${i + 1}. ${options[k].label}`));
  for (;;) {
    const n = Number((await rl.question("> ")).trim());
    if (Number.isInteger(n) && n >= 1 && n <= keys.length) return keys[n - 1];
    say(`Enter a number from 1 to ${keys.length}.`);
  }
}

async function ask(question, fallback, valid = () => true) {
  for (;;) {
    const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback || "";
    if (valid(answer)) return answer;
    say("That doesn't look right; try again.");
  }
}

const yes = async (question) => /^y(es)?$/i.test((await rl.question(`${question} (y/N): `)).trim());

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const copy = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(file, copy);
  return copy;
}

/** Start the server once with signing off, so the wallet exists and we can show its address. */
async function walletStatus(env) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const quiet = Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("GNOPULSE_POLICY_")));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(HERE, "launch.mjs")],
    env: { ...process.env, ...quiet, GNOPULSE_SIGNER: "none" },
    stderr: "ignore"
  });
  const client = new Client({ name: "gnopulse-setup", version: VERSION });
  await client.connect(transport);
  try {
    const r = await client.callTool({ name: "gno_agent_status", arguments: {} }, undefined, { timeout: 60000 });
    return JSON.parse(r.content[0].text);
  } finally {
    await client.close();
  }
}

async function main() {
  say(`GnoPulse MCP ${VERSION} setup. Nothing is written until you confirm.\n`);
  const targets = appTargets();
  const app = await choose("Which app should use GnoPulse?", targets);
  const target = targets[app];
  const network = await choose("\nWhich network?", NETWORKS);
  const mode = await choose("\nWhat may the agent do?", MODES);

  const answers = { network, mode };
  if (mode !== "data") {
    answers.agentId = await ask(
      "\nName this agent's wallet (lowercase letters, digits, - or _; the same name reuses the same wallet)",
      "my-agent",
      validAgentId
    );
  }
  if (mode === "autonomous") {
    answers.preset = await choose("\nWhat may it do on its own?", PRESETS);
    answers.maxSendUgnot = gnotToUgnot(
      await ask("Most GNOT it may send in one transaction", network === "onyx" ? "1" : "0.5", (v) => gnotToUgnot(v) !== null)
    );
    answers.hours = Number(
      await ask("For how many hours? It stops acting after that until you run setup again", "24", (v) => Number(v) > 0 && Number(v) <= 24 * 90)
    );
  }
  const key = process.env.GNOPULSE_API_KEY;
  answers.apiKey =
    key && (await yes("\nUse the GNOPULSE_API_KEY from your environment?"))
      ? key
      : await ask("\nGnoPulse API key for data tools (from gnopulse.xyz; Enter to skip)", "");

  const env = buildEnv(answers);
  // Testing an unreleased build: GNOPULSE_SETUP_PACKAGE names a local package (such as a tarball)
  // and GNOTX_BIN the signer built with it.
  if (process.env.GNOPULSE_SETUP_PACKAGE && process.env.GNOTX_BIN) env.GNOTX_BIN = process.env.GNOTX_BIN;
  const npx = path.join(path.dirname(process.execPath), process.platform === "win32" ? "npx.cmd" : "npx");
  const entry = serverEntry(env, fs.existsSync(npx) ? npx : "npx", VERSION, process.env.GNOPULSE_SETUP_PACKAGE || undefined);
  const shown = { ...entry, env: { ...env, ...(env.GNOPULSE_API_KEY ? { GNOPULSE_API_KEY: "(your key)" } : {}) } };

  let name = "gnopulse";
  const current = target.file && fs.existsSync(target.file) ? fs.readFileSync(target.file, "utf8") : "";
  if (target.file && hasServer(target, current, name) && !(await yes(`\n${target.label} already has a "${name}" server. Replace it?`)))
    name = await ask("Name for the new server", `gnopulse-${answers.agentId || "data"}`, (v) => /^[A-Za-z0-9_-]+$/.test(v));
  if (target.file && current) {
    const others = otherGnopulseServers(target, current, name);
    if (others.length)
      say(
        `\nNote: ${target.label} also runs ${others.join(", ")}. Each GnoPulse server adds about 79 tools; ` +
          "OpenAI models (Codex, ChatGPT) see at most 128, so turn the others off there."
      );
  }

  const appName = target.kind === "print" ? "your app" : target.label;
  say(`\nThis is the "${name}" server for ${appName}:\n`);
  say(JSON.stringify(shown, null, 2));
  if (mode === "autonomous") {
    const p = PRESETS[answers.preset];
    say(
      `\nIt will act without asking: ${p.funcs.join(", ")} on ${p.realms.join(", ")}; at most ` +
        `${Number(answers.maxSendUgnot) / 1e6} GNOT sent per transaction; until ` +
        `${new Date(Number(env.GNOPULSE_POLICY_EXPIRES_AT) * 1000).toLocaleString()}.`
    );
  }

  if (target.kind === "print") {
    say("\nCopy it into your app's MCP settings under mcpServers.");
  } else if (target.kind === "claude-cli") {
    const claude = spawnSync("claude", ["--version"], { encoding: "utf8" });
    if (claude.error || claude.status !== 0) {
      say("\nThe `claude` command was not found. Copy the config above into Claude Code's MCP settings instead.");
    } else if (await yes("\nAdd it to Claude Code for your user account?")) {
      spawnSync("claude", ["mcp", "remove", "--scope", "user", name], { stdio: "ignore" });
      const added = spawnSync("claude", ["mcp", "add-json", "--scope", "user", name, JSON.stringify(entry)], { encoding: "utf8" });
      say(added.status === 0 ? "Added." : `Claude Code refused it: ${(added.stderr || added.stdout).trim()}`);
      if (added.status !== 0) return finish(false);
    } else return finish(false);
  } else if (await yes(`\nWrite it to ${target.file}?`)) {
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    const saved = backup(target.file);
    const next = target.kind === "toml" ? applyToml(current, name, entry) : applyJson(current, target.key, name, entry);
    fs.writeFileSync(target.file, next, { mode: 0o600 });
    say(`Written.${saved ? ` The previous file is saved as ${saved}.` : ""}`);
  } else return finish(false);

  if (mode !== "data") {
    say("\nCreating the agent wallet...");
    try {
      const s = await walletStatus(env);
      say(`Wallet: ${s.address}`);
      say(`Balance: ${s.balance_ugnot === null ? "unknown" : `${Number(s.balance_ugnot) / 1e6} GNOT`}`);
      if (!s.funded)
        say(
          network === "onyx"
            ? "Get free test GNOT for it at https://faucet.gno.land (Onyx)."
            : "Send it a small amount of GNOT from your own wallet. 3 GNOT covers a first swap."
        );
    } catch (e) {
      say(`Could not start the wallet yet (${e.message}). It is created the first time your app starts the server.`);
    }
  }
  return finish(true, appName, mode);
}

function finish(done, appName, mode) {
  if (!done) {
    say("\nNothing was written.");
    rl.close();
    return;
  }
  say(`\nNext: restart ${appName}, then ask the agent: "What is your GnoPulse wallet status?"`);
  if (mode === "approval")
    say("You will approve each transaction in a window on this computer or in the app's approval form.");
  if (mode !== "data") {
    say("\nBefore you fund it:");
    for (const line of BEFORE_YOU_FUND) say(line.startsWith("  ") ? line : `- ${line}`);
  }
  rl.close();
}

main().catch((e) => {
  say(`Setup failed: ${e.message}`);
  rl.close();
  process.exit(1);
});
