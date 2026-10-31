// Who can approve a transaction, in order: a system window on this computer, an MCP form, or
// nobody, in which case the agent is told why and what to update before any preview.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerExecutionTools } from "../dist/tools/execution.js";
import { ConfigurablePolicy } from "../dist/signer/policy.js";
import { systemDialog } from "../dist/signer/systemDialog.js";

const ADDRESS = "g1drrtr9ryq9d24z7pczuf22hj8ry3l6mv6wny6k";
const ACCOUNT = JSON.stringify({ BaseAccount: { address: ADDRESS, coins: "5000000ugnot", account_number: "1", sequence: "0" } });
const PREVIEW = {
  ok: true,
  gas_wanted: 13830177,
  extra: {
    estimated_fee_ugnot: "16597",
    estimated_storage_deposit_ugnot: "207900",
    storage_deposit_limit_ugnot: "207900",
    estimated_storage_refund_ugnot: "0",
    estimated_total_fee_ugnot: "224497"
  }
};

function setup({ dialog = null, capabilities = {}, client = { name: "claude-code", version: "2.1.37" } } = {}) {
  const handlers = {};
  const calls = { simulated: 0, executed: 0, asked: [] };
  const server = {
    registerTool(name, _c, fn) { handlers[name] = fn; },
    server: {
      getClientCapabilities: () => capabilities,
      getClientVersion: () => client,
      elicitInput: async () => ({ action: "accept", content: { approve: true } })
    }
  };
  const store = new Map();
  registerExecutionTools(server, {
    gnotx: { verifiedHealth: async () => ({ ok: true }), simulateCall: async () => { calls.simulated++; return PREVIEW; } },
    rpc: { authAccount: async () => ACCOUNT },
    policy: new ConfigurablePolicy({ defaultAllow: true, allowRealms: [], denyRealms: [], allowFuncs: [], denyFuncs: [] }),
    signer: { requiresApproval: true, execute: async () => { calls.executed++; return { ok: true, txHash: "TX" }; } },
    approvals: {
      ttlSeconds: 300,
      create(intent, preview) { const p = { token: "t" + store.size, intent, preview, expiresAt: Date.now() + 300000 }; store.set(p.token, p); return p; },
      take(token) { const p = store.get(token); store.delete(token); return p; }
    },
    chainId: "gnoland-1",
    agentAddress: ADDRESS,
    agentId: "test",
    approvalDialog: dialog && { kind: "test", ask: async (message) => { calls.asked.push(message); return dialog; } }
  });
  return { handlers, calls };
}
const body = (r) => JSON.parse(r.content[0].text);
const extra = () => ({ signal: new AbortController().signal, _meta: {} });
const wrap = { pkgpath: "gno.land/r/gnoland/wugnot", func: "Deposit", send: "1000ugnot" };

test("a client with no forms and no desktop is refused at the proposal, naming the update", async () => {
  const { handlers, calls } = setup();
  const r = body(await handlers.gno_call(wrap));
  assert.equal(r.status, "approval_unavailable");
  assert.match(r.reason, /claude-code 2\.1\.37 cannot show transaction approval forms/);
  assert.match(r.reason, /npm i -g @anthropic-ai\/claude-code@latest/);
  assert.equal(r.approval_token, undefined);
  const s = body(await handlers.gno_agent_status({}));
  assert.deepEqual(s.approval_methods, []);
  assert.match(s.next_steps[0], /cannot show transaction approval forms/);
});

test("the system window approves, and its answer decides", async () => {
  for (const [answer, status, executed] of [["approve", "executed", 1], ["decline", "approval_declined", 0], ["timeout", "approval_expired", 0], ["error", "approval_failed", 0]]) {
    const { handlers, calls } = setup({ dialog: answer });
    const proposal = body(await handlers.gno_call(wrap));
    assert.equal(proposal.status, "awaiting_approval");
    const r = body(await handlers.gno_confirm({ token: proposal.approval_token }, extra()));
    assert.equal(r.status, status, answer);
    assert.equal(calls.executed, executed, answer);
    assert.match(calls.asked[0], /^Deposit 0\.001 GNOT into wrapped GNOT \(wugnot\)\.\nCosts up to 0\.225497 GNOT/);
  }
});

test("the system window comes before the client's form", async () => {
  const { handlers, calls } = setup({ dialog: "decline", capabilities: { elicitation: { form: {} } } });
  const proposal = body(await handlers.gno_call(wrap));
  assert.equal(body(await handlers.gno_confirm({ token: proposal.approval_token }, extra())).status, "approval_declined");
  assert.equal(calls.asked.length, 1);
  assert.equal(calls.executed, 0);
  assert.deepEqual(body(await handlers.gno_agent_status({})).approval_methods, ["system_dialog", "mcp_elicitation"]);
});

test("without a desktop, a client with forms still approves through its form", async () => {
  const { handlers, calls } = setup({ capabilities: { elicitation: { form: {} } } });
  const proposal = body(await handlers.gno_call(wrap));
  assert.equal(body(await handlers.gno_confirm({ token: proposal.approval_token }, extra())).status, "executed");
  assert.equal(calls.executed, 1);
});

test("no dialog when switched off, over SSH, or on Linux without a display", () => {
  assert.equal(systemDialog({ GNOPULSE_APPROVAL_DIALOG: "off" }, "darwin"), null);
  assert.equal(systemDialog({ SSH_CONNECTION: "1 2 3 4" }, "darwin"), null);
  assert.equal(systemDialog({ PATH: "/usr/bin" }, "linux"), null);
});

test("the dialog program gets the text as one argument, so it cannot inject commands", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dialog-"));
  const log = path.join(dir, "args.json");
  fs.writeFileSync(path.join(dir, "zenity"), `#!${process.execPath}\nrequire("fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(0);\n`, { mode: 0o755 });
  const dialog = systemDialog({ PATH: dir, DISPLAY: ":0" }, "linux");
  assert.equal(dialog.kind, "zenity");
  const text = 'Call "Buy" on realm "x"; $(touch /tmp/pwned) `id` <b>bold</b>';
  assert.equal(await dialog.ask(text, 5000, new AbortController().signal), "approve");
  const args = JSON.parse(fs.readFileSync(log, "utf8"));
  assert.ok(args.includes(`--text=${text}`));
  assert.ok(args.includes("--no-markup"));
  assert.ok(args.includes("--default-cancel"));
});

test("a dialog left open past the approval expiry counts as expired and is closed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dialog-"));
  fs.writeFileSync(path.join(dir, "zenity"), `#!${process.execPath}\nsetTimeout(() => process.exit(0), 10000);\n`, { mode: 0o755 });
  const dialog = systemDialog({ PATH: dir, DISPLAY: ":0" }, "linux");
  const started = Date.now();
  assert.equal(await dialog.ask("x", 1000, new AbortController().signal), "timeout");
  assert.ok(Date.now() - started < 5000);
});
