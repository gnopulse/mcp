// ApprovalStore: single-use tokens with expiry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalStore } from "../dist/signer/approvals.js";

const intent = { kind: "call", pkgpath: "gno.land/r/x", func: "F", summary: "t" };

test("create issues a token and take redeems it once", () => {
  const store = new ApprovalStore();
  const p = store.create(intent, { gas: 1 });
  assert.ok(p.token);
  const got = store.take(p.token);
  assert.equal(got.intent, intent);
  assert.equal(store.take(p.token), undefined);
});

test("unknown token yields undefined", () => {
  const store = new ApprovalStore();
  assert.equal(store.take("nope"), undefined);
});

test("expired token yields undefined", async () => {
  const store = new ApprovalStore(10);
  const p = store.create(intent, null);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(store.take(p.token), undefined);
});

test("ttlSeconds reflects the configured ttl", () => {
  assert.equal(new ApprovalStore(300000).ttlSeconds, 300);
});
