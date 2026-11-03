// `npx @gnopulse/mcp setup`: asks what the agent may do, writes it into the chosen app's MCP
// settings (after showing it and backing the file up), then creates the wallet and shows its address.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
import { interactive, openPrompt, say } from "./prompt.mjs";
import {
  backedUp,
  checkPositions,
  ensureSecret,
  keyName,
  markBackedUp,
  resolveGnotx,
  runGnotx,
  sameWord,
  walletDir
} from "./wallet-lib.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = require("../package.json").version;

if (!interactive()) {
  say("Run `npx @gnopulse/mcp setup` yourself in a terminal; it asks a few questions and may show a recovery phrase.");
  process.exit(1);
}
const prompt = openPrompt();
const { ask, choose, yes, rl } = prompt;

// The phrase is shown on the terminal's temporary screen, which keeps it out of the scrollback.
let onPhraseScreen = false;
const leavePhraseScreen = () => {
  if (onPhraseScreen) process.stdout.write("\x1b[?1049l");
  onPhraseScreen = false;
};
process.on("exit", leavePhraseScreen);
rl.on("SIGINT", () => process.exit(130));
const clearScreen = () => process.stdout.write("\x1b[2J\x1b[H");

/** Show the phrase until the user proves they saved it. False if they cancel. */
async function savePhrase(mnemonic) {
  const words = mnemonic.split(" ");
  process.stdout.write("\x1b[?1049h");
  onPhraseScreen = true;
  try {
    for (;;) {
      clearScreen();
      say("Your agent wallet's recovery phrase. It is shown only here, and is not saved anywhere.\n");
      for (let i = 0; i < words.length; i += 4)
        say(words.slice(i, i + 4).map((w, j) => `${String(i + j + 1).padStart(2)}. ${w.padEnd(10)}`).join("  "));
      say("\nWrite it down on paper. Anyone with these words controls the wallet, and your limits do not apply to them.");
      say("Never paste it into a chat or give it to an agent.\n");
      const go = await prompt.line("Press Enter once it is saved, or type q to cancel: ");
      if (/^q/i.test(go.trim())) return false;
      clearScreen();
      say("Check your copy.\n");
      let right = true;
      for (const position of checkPositions(words.length)) {
        if (!sameWord(await prompt.line(`Word ${position}: `), words[position - 1])) right = false;
      }
      if (right) return true;
      await prompt.line("\nThat does not match. Press Enter to see the phrase again.");
    }
  } finally {
    leavePhraseScreen();
  }
}

/** Create the wallet only after its phrase is saved. An existing wallet is never replaced. */
async function createWallet(env, agentId) {
  const dir = walletDir(process.env, env.GNO_CHAIN_ID || "gnoland-1", agentId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const gnotx = resolveGnotx(process.env);
  const password = ensureSecret(path.join(dir, ".pass"), 24);
  const keygen = ["keygen", "-home", dir, "-key", keyName(process.env), "-secrets-stdin"];
  if (runGnotx(gnotx, [...keygen, "-no-create"], { password }, process.env).address) {
    say("\nThis wallet already exists, so it keeps its key.");
    if (!backedUp(dir)) say("It has no recovery backup yet. To make one, run: npx @gnopulse/mcp backup");
    return true;
  }
  const { mnemonic } = runGnotx(gnotx, ["mnemonic"], null, process.env);
  if (!(await savePhrase(mnemonic))) return false;
  runGnotx(gnotx, keygen, { password, mnemonic }, process.env);
  markBackedUp(dir, "phrase");
  say("\nRecovery phrase saved. If you can still see it above, clear this terminal.");
  return true;
}

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
    env: { ...process.env, ...quiet, GNO_CHAIN_ID: env.GNO_CHAIN_ID || "gnoland-1", GNOPULSE_SIGNER: "none" },
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
  // The app must find the wallet setup makes, so it gets any location set in this shell.
  if (mode !== "data")
    for (const name of ["GNOPULSE_AGENT_HOME", "GNOPULSE_AGENT_KEY"]) if (process.env[name]) env[name] = process.env[name];
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

  // Confirm first, then the wallet and its phrase, and only then the config: an app that reloads
  // its config as it changes would otherwise create a wallet with no phrase while this one is on screen.
  let install = () => true;
  if (target.kind === "print") {
    say("\nCopy it into your app's MCP settings under mcpServers.");
  } else if (target.kind === "claude-cli") {
    const claude = spawnSync("claude", ["--version"], { encoding: "utf8" });
    if (claude.error || claude.status !== 0) {
      say("\nThe `claude` command was not found. Copy the config above into Claude Code's MCP settings instead.");
    } else if (await yes("\nAdd it to Claude Code for your user account?")) {
      install = () => {
        spawnSync("claude", ["mcp", "remove", "--scope", "user", name], { stdio: "ignore" });
        const added = spawnSync("claude", ["mcp", "add-json", "--scope", "user", name, JSON.stringify(entry)], { encoding: "utf8" });
        say(added.status === 0 ? "Added." : `Claude Code refused it: ${(added.stderr || added.stdout).trim()}`);
        return added.status === 0;
      };
    } else return finish(false);
  } else if (await yes(`\nWrite it to ${target.file}?`)) {
    install = () => {
      fs.mkdirSync(path.dirname(target.file), { recursive: true });
      const saved = backup(target.file);
      const next = target.kind === "toml" ? applyToml(current, name, entry) : applyJson(current, target.key, name, entry);
      fs.writeFileSync(target.file, next, { mode: 0o600 });
      say(`Written.${saved ? ` The previous file is saved as ${saved}.` : ""}`);
      return true;
    };
  } else return finish(false);

  let walletReady = mode === "data";
  if (mode !== "data") {
    try {
      if (!(await createWallet(env, answers.agentId))) {
        say("\nNo wallet was created and nothing was written. Run setup again when you can save the phrase.");
        prompt.close();
        return;
      }
      walletReady = true;
    } catch (e) {
      say(
        `\nCould not create the wallet (${e.message}). Until you run setup again, the server runs with data tools ` +
          "only and signing off."
      );
    }
  }
  if (!install()) return finish(false);

  if (walletReady && mode !== "data") {
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
      say(`Could not read the wallet yet (${e.message}). Ask your agent for its status once the app restarts.`);
    }
  }
  return finish(true, appName, mode);
}

function finish(done, appName, mode) {
  if (!done) {
    say("\nNothing was written.");
    prompt.close();
    return;
  }
  say(`\nNext: restart ${appName}, then ask the agent: "What is your GnoPulse wallet status?"`);
  if (mode === "approval")
    say("You will approve each transaction in a window on this computer or in the app's approval form.");
  if (mode !== "data") {
    say("\nBefore you fund it:");
    for (const line of BEFORE_YOU_FUND) say(line.startsWith("  ") ? line : `- ${line}`);
  }
  prompt.close();
}

main().catch((e) => {
  say(`Setup failed: ${e.message}`);
  prompt.close();
  process.exit(1);
});
