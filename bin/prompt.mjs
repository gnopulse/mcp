// Terminal questions for setup and backup. Secrets typed here are not echoed.
import readline from "node:readline/promises";
import { Writable } from "node:stream";

export const say = (line = "") => process.stdout.write(line + "\n");

/** True only in a real terminal, so a phrase cannot be read through a pipe or a captured command. */
export const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb");

export function openPrompt() {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding);
      done();
    }
  });
  output.columns = process.stdout.columns;
  // No history: the up arrow must not bring back a passphrase or a phrase word.
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  let closing = false;
  rl.on("close", () => {
    if (closing) return;
    say("\nStopped.");
    process.exit(130);
  });

  const ask = async (question, fallback, valid = () => true) => {
    for (;;) {
      const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim() || fallback || "";
      if (valid(answer)) return answer;
      say("That doesn't look right; try again.");
    }
  };

  return {
    rl,
    ask,
    line: (question) => rl.question(question),
    yes: async (question) => /^y(es)?$/i.test((await rl.question(`${question} (y/N): `)).trim()),
    async choose(question, options) {
      const keys = Object.keys(options);
      say(question);
      keys.forEach((k, i) => say(`  ${i + 1}. ${options[k].label}`));
      for (;;) {
        const n = Number((await rl.question("> ")).trim());
        if (Number.isInteger(n) && n >= 1 && n <= keys.length) return keys[n - 1];
        say(`Enter a number from 1 to ${keys.length}.`);
      }
    },
    async hidden(question) {
      process.stdout.write(question);
      muted = true;
      try {
        return await rl.question("");
      } finally {
        muted = false;
        say();
      }
    },
    close() {
      closing = true;
      rl.close();
    }
  };
}
