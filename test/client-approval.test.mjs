import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  approvalChallenge,
  signClientApproval,
  verifyClientApproval
} from "../dist/signer/clientApproval.js";
const pair = () =>
  generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
const keys = pair();
const pending = () => ({
  token: randomUUID(),
  expiresAt: Date.now() + 60000,
  intent: {
    kind: "call",
    pkgpath: "gno.land/r/demo/x",
    func: "Ping",
    args: ["one"],
    send: "1ugnot",
    summary: "Ping",
    executionLimits: { gasWanted: 130000, feeUgnot: "100001", storageDepositUgnot: "1" }
  },
  preview: { ok: true, gas_wanted: 130000 }
});

test("client authorization binds every transaction and identity field", () => {
  const p = pending(),
    c = approvalChallenge(p, "agent", "onyx-1", "g1wallet"),
    r = signClientApproval(c, keys.privateKey, "approve");
  assert(verifyClientApproval(r, c, keys.publicKey));
  for (const mutate of [
    (x) => (x.chain = "gnoland-1"),
    (x) => (x.wallet = "other"),
    (x) => (x.agent = "other"),
    (x) => (x.token = "other"),
    (x) => x.expiresAt++,
    (x) => (x.intent.args[0] = "two"),
    (x) => (x.intent.func = "Transfer"),
    (x) => (x.intent.send = "2ugnot"),
    (x) => (x.intent.executionLimits.feeUgnot = "999999"),
    (x) => (x.intent.executionLimits.storageDepositUgnot = "999999"),
    (x) => (x.previewDigest = "other")
  ]) {
    const changed = structuredClone(c);
    mutate(changed);
    assert.equal(verifyClientApproval(r, changed, keys.publicKey), false);
  }
  assert.equal(verifyClientApproval(r, c, pair().publicKey), false);
});

test("declines, forged flags, malformed signatures and expired approvals cannot authorize", () => {
  const c = approvalChallenge(pending(), "agent", "onyx-1", "g1wallet");
  for (const r of [
    { approved: true },
    {},
    null,
    signClientApproval(c, keys.privateKey, "deny"),
    { ...signClientApproval(c, keys.privateKey, "approve"), signature: "bad" }
  ])
    assert.equal(verifyClientApproval(r, c, keys.publicKey), false);
  const expired = { ...c, expiresAt: Date.now() - 1 };
  assert.throws(() => signClientApproval(expired, keys.privateKey, "approve"), /expired/);
  assert.equal(verifyClientApproval({}, expired, keys.publicKey), false);
});
