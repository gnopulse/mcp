// With signing off, the status says where the keys are: a local agent wallet can exist even
// though this server will not sign, while the hosted server holds none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerExecutionTools } from "../dist/tools/execution.js";

async function note(deps) {
  const handlers = {};
  registerExecutionTools({ registerTool(name, _c, fn) { handlers[name] = fn; } }, {
    gnotx: { verifiedHealth: async () => ({ ok: true }) },
    rpc: { authAccount: async () => "null" },
    policy: {},
    signer: null,
    approvals: {},
    chainId: "onyx-1",
    ...deps
  });
  return JSON.parse((await handlers.gno_agent_status({})).content[0].text).next_steps[0];
}

test("a local agent wallet with signing off is named, not denied", async () => {
  const text = await note({ agentAddress: "g1agent" });
  assert.match(text, /This computer holds the agent wallet g1agent/);
  assert.match(text, /No tool call can turn signing on/);
  assert.doesNotMatch(text, /holds no/);
});

test("without an agent ID, the status says how to create one", async () => {
  assert.match(await note({}), /no agent wallet is configured; set GNOPULSE_AGENT_ID/);
});

test("the hosted server still says it holds no wallet keys", async () => {
  assert.match(await note({ readOnly: true }), /hosted server is read\/simulate-only and holds no wallet keys/);
});
