// ConfigurablePolicy decisions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigurablePolicy, loadPolicy, parseUgnot, PolicyConfigError } from "../dist/signer/policy.js";

const base = { defaultAllow: true, allowRealms: [], denyRealms: [], allowFuncs: [], denyFuncs: [] };
const callIntent = (over = {}) => ({ kind: "call", pkgpath: "gno.land/r/demo/x", func: "Ping", summary: "t", ...over });

test("parseUgnot", () => {
  assert.equal(parseUgnot("1000ugnot"), 1000n);
  assert.equal(parseUgnot(""), 0n);
  assert.equal(parseUgnot(undefined), 0n);
  assert.equal(parseUgnot("5uatom"), null);
  assert.equal(parseUgnot("abc"), null);
});

test("default-allow with no rules allows", () => {
  const p = new ConfigurablePolicy(base);
  assert.deepEqual(p.check(callIntent()), { allow: true });
  assert.equal(p.restrictive, false);
});

test("denylist blocks the realm", () => {
  const p = new ConfigurablePolicy({ ...base, denyRealms: ["gno.land/r/demo/x"] });
  const d = p.check(callIntent());
  assert.equal(d.allow, false);
  assert.match(d.reason, /denylist/);
});

test("allowlist permits only listed realms", () => {
  const p = new ConfigurablePolicy({ ...base, allowRealms: ["gno.land/r/demo/ok"] });
  assert.equal(p.check(callIntent({ pkgpath: "gno.land/r/demo/ok" })).allow, true);
  assert.equal(p.check(callIntent({ pkgpath: "gno.land/r/demo/x" })).allow, false);
});

test("per-tx send cap", () => {
  const p = new ConfigurablePolicy({ ...base, maxSendUgnot: 1000n });
  assert.equal(p.check(callIntent({ send: "500ugnot" })).allow, true);
  assert.equal(p.check(callIntent({ send: "2000ugnot" })).allow, false);
  // A send in another denom cannot be checked against the cap.
  assert.equal(p.check(callIntent({ send: "5uatom" })).allow, false);
});

test("default-deny is restrictive and blocks unmatched", () => {
  const p = new ConfigurablePolicy({ ...base, defaultAllow: false });
  assert.equal(p.check(callIntent()).allow, false);
  assert.equal(p.restrictive, true);
});

test("default-deny with an allowlist allows listed realms", () => {
  const p = new ConfigurablePolicy({ ...base, defaultAllow: false, allowRealms: ["gno.land/r/demo/ok"] });
  assert.equal(p.restrictive, true);
  assert.equal(p.check(callIntent({ pkgpath: "gno.land/r/demo/ok", func: "Mint" })).allow, true);
  const denied = p.check(callIntent({ pkgpath: "gno.land/r/demo/other", func: "Approve" }));
  assert.equal(denied.allow, false);
  assert.match(denied.reason, /allowlist/);
});

test("default-deny with an allowlist still enforces the send cap", () => {
  const p = new ConfigurablePolicy({ ...base, defaultAllow: false, allowRealms: ["gno.land/r/x"], maxSendUgnot: 1000n });
  assert.equal(p.check(callIntent({ pkgpath: "gno.land/r/x", send: "500ugnot" })).allow, true);
  assert.equal(p.check(callIntent({ pkgpath: "gno.land/r/x", send: "2000ugnot" })).allow, false);
});

test("expiry denies after expiresAt and allows before", () => {
  const expired = new ConfigurablePolicy({ ...base, expiresAt: 1000 }, () => 1500);
  const d = expired.check(callIntent());
  assert.equal(d.allow, false);
  assert.match(d.reason, /expired/);
  const live = new ConfigurablePolicy({ ...base, expiresAt: 2000 }, () => 1500);
  assert.equal(live.check(callIntent()).allow, true);
});

test("fees-only: allows zero-send calls, denies value transfers", () => {
  const p = new ConfigurablePolicy({ ...base, feesOnly: true });
  assert.equal(p.check(callIntent({ send: "" })).allow, true);
  assert.equal(p.check(callIntent({ send: "0ugnot" })).allow, true);
  const d = p.check(callIntent({ send: "1000ugnot" }));
  assert.equal(d.allow, false);
  assert.match(d.reason, /fees-only/);
  assert.equal(p.restrictive, true);
});

test("approve intent is checked against function rules", () => {
  const p = new ConfigurablePolicy({ ...base, denyFuncs: ["Approve"] });
  const intent = { kind: "approve", pkgpath: "gno.land/r/x", approve: { token: "gno.land/r/x", spender: "g1", amount: "1" }, summary: "t" };
  assert.equal(p.check(intent).allow, false);
});

test("deny lists and expiry alone are not restrictive", () => {
  const p = new ConfigurablePolicy({ ...base, denyRealms: ["gno.land/r/x"], denyFuncs: ["Transfer"], expiresAt: 2000 });
  assert.equal(p.restrictive, false);
});

test("allowlists, send cap, fees-only and default-deny are each restrictive", () => {
  for (const over of [
    { allowRealms: ["gno.land/r/x"] },
    { allowFuncs: ["Ping"] },
    { maxSendUgnot: 0n },
    { feesOnly: true },
    { defaultAllow: false },
  ]) {
    assert.equal(new ConfigurablePolicy({ ...base, ...over }).restrictive, true, Object.keys(over)[0]);
  }
});

test("loadPolicy parses numeric variables", () => {
  const p = loadPolicy({ GNOPULSE_POLICY_MAX_SEND_UGNOT: "1000", GNOPULSE_POLICY_EXPIRES_AT: "4000000000" });
  assert.equal(p.restrictive, true);
  assert.equal(p.check(callIntent({ send: "2000ugnot" })).allow, false);
  assert.equal(loadPolicy({}).restrictive, false);
});

for (const name of ["GNOPULSE_POLICY_EXPIRES_AT", "GNOPULSE_POLICY_EXPIRES_IN", "GNOPULSE_POLICY_MAX_SEND_UGNOT"]) {
  test(`loadPolicy rejects a malformed ${name}`, () => {
    for (const value of ["abc", "1.5", "-1", "5ugnot"]) {
      assert.throws(
        () => loadPolicy({ [name]: value }),
        (e) => e instanceof PolicyConfigError && e.message.startsWith(`${name}="${value}" is invalid`),
      );
    }
  });
}
