// `npx @gnopulse/mcp backup`: writes an existing wallet's key to a passphrase-encrypted file.
// Wallets made by setup also have a recovery phrase; a phrase that was not saved cannot be read back.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { interactive, openPrompt, say } from "./prompt.mjs";
import { expandHome, homeRoot, keyName, listWallets, markBackedUp, resolveGnotx, runGnotx } from "./wallet-lib.mjs";

const MIN_PASSPHRASE = 12;

if (!interactive()) {
  say("Run `npx @gnopulse/mcp backup` yourself in a terminal. It does not run through a pipe or an agent.");
  process.exit(1);
}

const prompt = openPrompt();
prompt.rl.on("SIGINT", () => {
  say("\nNothing was written.");
  process.exit(130);
});

async function main() {
  const gnotx = resolveGnotx(process.env);
  // A folder can exist with no key in it, as when setup was cancelled at the phrase.
  const wallets = listWallets(process.env)
    .map((w) => {
      const password = fs.readFileSync(path.join(w.dir, ".pass"), "utf8").trim();
      const args = ["keygen", "-home", w.dir, "-key", keyName(process.env), "-no-create", "-secrets-stdin"];
      return { ...w, password, address: runGnotx(gnotx, args, { password }, process.env).address };
    })
    .filter((w) => w.address);
  if (!wallets.length) {
    say(`No agent wallets were found in ${homeRoot(process.env)}.`);
    say("If your app's settings set GNOPULSE_AGENT_HOME or GNOPULSE_AGENT_KEY, run this again with the same values.");
    say("Keys from before agent IDs, kept directly in ~/.gnopulse-agent, are not listed. Copy that folder somewhere safe instead.");
    return;
  }
  const options = Object.fromEntries(wallets.map((w, i) => [i, { label: `${w.agent} on ${w.chain} (${w.address})` }]));
  const wallet = wallets[Number(await prompt.choose("Which wallet do you want to back up?", options))];

  say("\nThis writes the wallet's key to a file locked with a passphrase you choose.");
  say("Anyone with both the file and the passphrase controls the wallet, and your limits do not apply to them.");
  say("Nobody can recover a lost passphrase. Never type it into a chat or give it to an agent.\n");
  let passphrase;
  for (;;) {
    passphrase = await prompt.hidden(`Passphrase (at least ${MIN_PASSPHRASE} characters): `);
    if (passphrase.length < MIN_PASSPHRASE) {
      say("That is too short.");
      continue;
    }
    // gnokey trims what is typed, so these could never be restored.
    if (passphrase !== passphrase.trim()) {
      say("It can't start or end with a space.");
      continue;
    }
    if ((await prompt.hidden("Type it again: ")) === passphrase) break;
    say("They did not match.");
  }

  const fallback = path.join(os.homedir(), `gnopulse-wallet-${wallet.chain}-${wallet.agent}.key`);
  let out;
  for (;;) {
    out = path.resolve(expandHome(await prompt.ask("\nSave the file as", fallback)));
    if (!fs.existsSync(out)) break;
    say("That file already exists, and a backup never replaces a file. Choose another name.");
  }
  const result = runGnotx(
    gnotx,
    ["export", "-home", wallet.dir, "-key", keyName(process.env), "-out", out],
    { password: wallet.password, passphrase },
    process.env
  );
  markBackedUp(wallet.dir, "file");
  say(`\nSaved and checked: it decrypts back to ${result.address}.`);
  say(`File: ${out}`);
  say("Move it off this computer, and keep the passphrase somewhere separate.");
  say(`To restore it: gnokey import -name ${wallet.agent} -armor-path <file>`);
}

try {
  await main();
} catch (e) {
  say(`Backup failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  prompt.close();
}
