// ConfigurablePolicy decisions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigurablePolicy, loadPolicy, parseUgnot, PolicyConfigError } from "../dist/signer/policy.js";

const base = { defaultAllow: true, allowRealms: [], denyRealms: [], allowFuncs: [], denyFuncs: [] };
const callIntent = (over = {}) => ({
  kind: "call",
  pkgpath: "gno.land/r/demo/x",
  func: "Ping",
  summary: "t",
  ...over
});

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
  const p = new ConfigurablePolicy({
    ...base,
    defaultAllow: false,
    allowRealms: ["gno.land/r/x"],
    maxSendUgnot: 1000n
  });
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
});

test("approve intent is checked against function rules", () => {
  const p = new ConfigurablePolicy({ ...base, denyFuncs: ["Approve"] });
  const intent = {
    kind: "approve",
    pkgpath: "gno.land/r/x",
    approve: { token: "gno.land/r/x", spender: "g1", amount: "1" },
    summary: "t"
  };
  assert.equal(p.check(intent).allow, false);
});

test("deny lists and expiry alone are not restrictive", () => {
  const p = new ConfigurablePolicy({
    ...base,
    denyRealms: ["gno.land/r/x"],
    denyFuncs: ["Transfer"],
    expiresAt: 2000
  });
  assert.equal(p.restrictive, false);
});

test("allowlists and default-deny are each restrictive", () => {
  for (const over of [{ allowRealms: ["gno.land/r/x"] }, { allowFuncs: ["Ping"] }, { defaultAllow: false }]) {
    assert.equal(new ConfigurablePolicy({ ...base, ...over }).restrictive, true, Object.keys(over)[0]);
  }
});

test("loadPolicy parses numeric variables", () => {
  const p = loadPolicy({ GNOPULSE_POLICY_MAX_SEND_UGNOT: "1000", GNOPULSE_POLICY_EXPIRES_AT: "4000000000" });
  assert.equal(p.check(callIntent({ send: "2000ugnot" })).allow, false);
  assert.equal(loadPolicy({}).restrictive, false);
  assert.equal(loadPolicy({ GNOPULSE_POLICY_ALLOW_FUNCS: "Ping" }).restrictive, true);
});

for (const name of [
  "GNOPULSE_POLICY_EXPIRES_AT",
  "GNOPULSE_POLICY_EXPIRES_IN",
  "GNOPULSE_POLICY_MAX_SEND_UGNOT"
]) {
  test(`loadPolicy rejects a malformed ${name}`, () => {
    for (const value of ["abc", "1.5", "-1", "5ugnot"]) {
      assert.throws(
        () => loadPolicy({ [name]: value }),
        (e) => e instanceof PolicyConfigError && e.message.startsWith(`${name}="${value}" is invalid`)
      );
    }
  });
}

test("a native-ugnot cap does not make a policy restrictive", () => {
  // maxSendUgnot and feesOnly both read intent.send, which is native ugnot. A GRC20 transfer is
  // an ordinary call with an empty send, so neither bounds it, and an autonomous signer gated on
  // `restrictive` must not accept them as a bound.
  assert.equal(new ConfigurablePolicy({ ...base, maxSendUgnot: 1n }).restrictive, false);
  assert.equal(new ConfigurablePolicy({ ...base, feesOnly: true }).restrictive, false);
});

test("bounding what may be called makes a policy restrictive", () => {
  assert.equal(new ConfigurablePolicy({ ...base, allowRealms: ["gno.land/r/demo/x"] }).restrictive, true);
  assert.equal(new ConfigurablePolicy({ ...base, allowFuncs: ["Ping"] }).restrictive, true);
  assert.equal(new ConfigurablePolicy({ ...base, defaultAllow: false }).restrictive, true);
});

test("feesOnly still denies a native send", () => {
  // Narrowing `restrictive` must not change what the policy actually enforces.
  const p = new ConfigurablePolicy({ ...base, feesOnly: true });
  assert.equal(p.check(callIntent({ send: "1ugnot" })).allow, false);
  assert.equal(p.check(callIntent({ send: "" })).allow, true);
});

test("feesOnly does not stop a GRC20 transfer, which is why it is not a bound", () => {
  const p = new ConfigurablePolicy({ ...base, feesOnly: true });
  const transfer = callIntent({ pkgpath: "gno.land/r/demo/tok", func: "Transfer", send: "" });
  assert.equal(p.check(transfer).allow, true);
});

const swapIntent = {
  kind: "swap",
  swap: { tokenIn: "a", tokenOut: "b", amountIn: "1", minOut: "1", deadline: 1999999999 },
  summary: "swap"
};
const router = "gno.land/r/gnoswap/router";
test("swap policy checks the actual router and function", () => {
  assert.equal(new ConfigurablePolicy({ ...base, denyRealms: [router] }).check(swapIntent).allow, false);
  assert.equal(
    new ConfigurablePolicy({ ...base, denyFuncs: ["ExactInSwapRoute"] }).check(swapIntent).allow,
    false
  );
  assert.equal(
    new ConfigurablePolicy({
      ...base,
      defaultAllow: false,
      allowRealms: [router],
      allowFuncs: ["ExactInSwapRoute"]
    }).check(swapIntent).allow,
    true
  );
  assert.equal(
    new ConfigurablePolicy({ ...base, allowRealms: ["gno.land/r/other"] }).check(swapIntent).allow,
    false
  );
  assert.equal(
    new ConfigurablePolicy({ ...base, denyRealms: [router] }).check({
      ...swapIntent,
      pkgpath: "gno.land/r/safe",
      func: "Safe"
    }).allow,
    false
  );
});

test("autonomous grant needs all bounds and enforces gas, fees and expiry", () => {
  let now = 100;
  const cfg = {
    ...base,
    allowRealms: ["gno.land/r/demo/x"],
    allowFuncs: ["Ping"],
    maxSendUgnot: 0n,
    maxFeeUgnot: 100n,
    maxGasWanted: 1000,
    expiresAt: 110
  };
  const p = new ConfigurablePolicy(cfg, () => now);
  assert.equal(p.boundedAutonomy, true);
  for (const k of ["maxSendUgnot", "maxFeeUgnot", "maxGasWanted", "expiresAt"]) {
    const changed = { ...cfg };
    delete changed[k];
    assert.equal(new ConfigurablePolicy(changed, () => now).boundedAutonomy, false);
  }
  assert.equal(p.check(callIntent({ executionLimits: { gasWanted: 1000, feeUgnot: "100" } })).allow, true);
  assert.equal(p.check(callIntent({ executionLimits: { gasWanted: 1001, feeUgnot: "100" } })).allow, false);
  assert.equal(p.check(callIntent({ executionLimits: { gasWanted: 1000, feeUgnot: "101" } })).allow, false);
  now = 110;
  assert.equal(p.boundedAutonomy, false);
  assert.equal(p.check(callIntent()).allow, false);
  assert.throws(() => loadPolicy({ GNOPULSE_POLICY_MAX_GAS: "9007199254740992" }), PolicyConfigError);
});

test("each refusal names the setting and change that would allow it", () => {
  const p = new ConfigurablePolicy({
    defaultAllow: false, allowRealms: ["gno.land/r/gnoland/wugnot"], denyRealms: [], allowFuncs: ["Deposit"], denyFuncs: [],
    maxSendUgnot: 1000n
  });
  const realm = p.check({ kind: "call", pkgpath: "gno.land/r/gnoswap/gns", func: "Deposit", summary: "" });
  assert.equal(realm.setting, "GNOPULSE_POLICY_ALLOW_REALMS");
  assert.equal(realm.change, "add gno.land/r/gnoswap/gns");
  const func = p.check({ kind: "call", pkgpath: "gno.land/r/gnoland/wugnot", func: "Withdraw", summary: "" });
  assert.equal(func.setting, "GNOPULSE_POLICY_ALLOW_FUNCS");
  const send = p.check({ kind: "call", pkgpath: "gno.land/r/gnoland/wugnot", func: "Deposit", send: "5000ugnot", summary: "" });
  assert.deepEqual([send.setting, send.change], ["GNOPULSE_POLICY_MAX_SEND_UGNOT", "raise it to at least 5000"]);
});

test("missing autonomy settings are listed by name", () => {
  const p = new ConfigurablePolicy({ defaultAllow: false, allowRealms: ["r"], denyRealms: [], allowFuncs: [], denyFuncs: [], maxSendUgnot: 1n });
  assert.deepEqual(p.missingForAutonomy(), [
    "GNOPULSE_POLICY_ALLOW_FUNCS", "GNOPULSE_POLICY_MAX_FEE_UGNOT", "GNOPULSE_POLICY_MAX_GAS", "GNOPULSE_POLICY_EXPIRES_IN"
  ]);
});
