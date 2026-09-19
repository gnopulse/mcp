// Errors returned to a caller must not name internal endpoints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeErrorMessage } from "../dist/tools/util.js";

test("endpoints are redacted", () => {
  const e = new Error("all 3 RPC endpoint(s) failed for /status: fetch to https://rpc.internal:26657 failed");
  const out = safeErrorMessage(e);
  assert.ok(!out.includes("rpc.internal"), out);
  assert.ok(out.includes("<endpoint>"), out);
});

test("the kind of failure survives", () => {
  const e = new Error("HTTP 503");
  e.name = "RpcError";
  assert.ok(safeErrorMessage(e).startsWith("RpcError: "));
});

test("an upstream body cannot be pasted back in full", () => {
  const e = new Error("v2 /x: HTTP 500: " + "s".repeat(1000));
  assert.ok(safeErrorMessage(e).length < 400);
});

test("a plain message is unchanged", () => {
  assert.equal(safeErrorMessage(new Error("token not found")), "token not found");
});
