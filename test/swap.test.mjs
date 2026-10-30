// swapCallArgs and withApiKey.
import { test } from "node:test";
import assert from "node:assert/strict";
import { swapCallArgs, GNOSWAP_ROUTER } from "../dist/signer/execute.js";
import { withApiKey } from "../dist/config.js";

test("swapCallArgs builds router.ExactInSwapRoute args", () => {
  const args = swapCallArgs({
    tokenIn: "A",
    tokenOut: "B",
    amountIn: "100",
    minOut: "9"
  });
  assert.equal(args.length, 8);
  assert.equal(args[0], "A");
  assert.equal(args[1], "B");
  assert.equal(args[2], "100");
  assert.equal(args[3], "A:B:500"); // default fee tier
  assert.equal(args[4], "100"); // quote for a single route
  assert.equal(args[5], "9"); // minOut
  assert.match(args[6], /^\d+$/); // deadline, unix seconds
  assert.equal(args[7], ""); // referrer
});

test("swapCallArgs honors fee and an explicit route", () => {
  assert.equal(
    swapCallArgs({
      tokenIn: "A",
      tokenOut: "B",
      amountIn: "1",
      minOut: "1",
      fee: "3000"
    })[3],
    "A:B:3000"
  );
  assert.equal(
    swapCallArgs({
      tokenIn: "A",
      tokenOut: "B",
      amountIn: "1",
      minOut: "1",
      route: "A:C:100*POOL*C:B:500"
    })[3],
    "A:C:100*POOL*C:B:500"
  );
});

test("GNOSWAP_ROUTER is the router path", () => {
  assert.equal(GNOSWAP_ROUTER, "gno.land/r/gnoswap/router");
});

test("withApiKey overrides only when a key is given", () => {
  const cfg = { apiBase: "x", apiKey: "server" };
  assert.equal(withApiKey(cfg, "caller").apiKey, "caller");
  assert.equal(withApiKey(cfg, undefined).apiKey, "server");
  assert.equal(withApiKey(cfg, undefined), cfg);
});

test("approved swap deadline is stable across later execution", () => {
  const swap = {
    tokenIn: "a",
    tokenOut: "b",
    amountIn: "1",
    minOut: "1",
    deadline: 1700000000
  };
  assert.equal(swapCallArgs(swap)[6], "1700000000");
});

test("swapCallArgs passes a split route's quote", () => {
  const args = swapCallArgs({ tokenIn: "A", tokenOut: "C", amountIn: "1", minOut: "1", route: "A:B:3000,A:C:500", quote: "50,50" });
  assert.equal(args[3], "A:B:3000,A:C:500");
  assert.equal(args[4], "50,50");
});

test("gno_swap resolves bare realms to registry keys and refuses native GNOT", async () => {
  const { registerExecutionTools } = await import("../dist/tools/execution.js");
  const handlers = {};
  let seen;
  registerExecutionTools({ registerTool(name, _c, fn) { handlers[name] = fn; } }, {
    gnotx: {},
    rpc: {},
    policy: { check: async (intent) => { seen = intent; return { allow: false, reason: "stop" }; } },
    signer: { requiresApproval: true },
    approvals: {},
    chainId: "gnoland-1",
    resolveToken: async (t) => ({ "gno.land/r/gnoland/wugnot": "gno.land/r/gnoland/wugnot.wugnot", "gno.land/r/gnoswap/gns": "gno.land/r/gnoswap/gns.GNS" })[t] ?? t
  });
  await handlers.gno_swap({ tokenIn: "gno.land/r/gnoland/wugnot", tokenOut: "gno.land/r/gnoswap/gns", amountIn: "5", minOut: "1", fee: "3000" });
  assert.equal(seen.args[3], "gno.land/r/gnoland/wugnot.wugnot:gno.land/r/gnoswap/gns.GNS:3000");
  const r = await handlers.gno_swap({ tokenIn: "ugnot", tokenOut: "gno.land/r/gnoswap/gns", amountIn: "5", minOut: "1" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /wrapped GNOT/);
});
