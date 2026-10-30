// A new agent wallet has no on-chain account until it receives GNOT. That is "unfunded",
// not an RPC failure, and a write must say so before simulating.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerExecutionTools } from "../dist/tools/execution.js";
import { ConfigurablePolicy } from "../dist/signer/policy.js";

const ADDRESS = "g1drrtr9ryq9d24z7pczuf22hj8ry3l6mv6wny6k";

function tools(authAccount) {
  const handlers = {};
  let simulated = 0;
  registerExecutionTools({ registerTool(name, _c, fn) { handlers[name] = fn; } }, {
    gnotx: { verifiedHealth: async () => ({ ok: true }), simulateCall: async () => { simulated++; return {}; } },
    rpc: { authAccount },
    policy: new ConfigurablePolicy({ defaultAllow: true, allowRealms: [], denyRealms: [], allowFuncs: [], denyFuncs: [] }),
    signer: { requiresApproval: true },
    approvals: {},
    chainId: "gnoland-1",
    agentAddress: ADDRESS
  });
  return { handlers, simulated: () => simulated };
}
const body = (r) => JSON.parse(r.content[0].text);

test("a wallet with no account reports unfunded, not an unavailable balance", async () => {
  // Mainnet answers JSON null; an empty response means the same.
  for (const reply of ["null", { absent: true }]) {
    const s = body(await tools(async () => reply).handlers.gno_agent_status({}));
    assert.equal(s.balance_ugnot, "0");
    assert.equal(s.funded, false);
    assert.match(s.next_steps[0], new RegExp(`${ADDRESS} has no GNOT`));
  }
});

test("a write from a wallet with no account asks for funding before simulating", async () => {
  const t = tools(async () => "null");
  const r = body(await t.handlers.gno_call({ pkgpath: "gno.land/r/gnoland/wugnot", func: "Deposit", send: "1ugnot" }));
  assert.equal(r.status, "needs_funding");
  assert.equal(r.address, ADDRESS);
  assert.equal(t.simulated(), 0);
});

test("an RPC failure is still reported as unavailable", async () => {
  const s = body(await tools(async () => { throw new Error("down"); }).handlers.gno_agent_status({}));
  assert.equal(s.balance_ugnot, null);
  assert.match(s.next_steps[0], /unavailable/);
});
