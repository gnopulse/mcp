// swapCallArgs and withApiKey.
import { test } from "node:test";
import assert from "node:assert/strict";
import { swapCallArgs, GNOSWAP_ROUTER } from "../dist/signer/execute.js";
import { withApiKey } from "../dist/config.js";

test("swapCallArgs builds router.ExactInSwapRoute args", () => {
  const args = swapCallArgs({ tokenIn: "A", tokenOut: "B", amountIn: "100", minOut: "9" });
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
  assert.equal(swapCallArgs({ tokenIn: "A", tokenOut: "B", amountIn: "1", minOut: "1", fee: "3000" })[3], "A:B:3000");
  assert.equal(swapCallArgs({ tokenIn: "A", tokenOut: "B", amountIn: "1", minOut: "1", route: "A:C:100*POOL*C:B:500" })[3], "A:C:100*POOL*C:B:500");
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
