import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalMessage, previewLimits, formatGnot } from "../dist/signer/approvalDisplay.js";
const preview = {
  ok: true,
  gas_wanted: 11825188,
  extra: {
    estimated_fee_ugnot: "153727",
    estimated_storage_deposit_ugnot: "206100",
    storage_deposit_limit_ugnot: "206100",
    estimated_storage_refund_ugnot: "0",
    estimated_total_fee_ugnot: "359827"
  }
};
const intent = {
  kind: "call",
  pkgpath: "gno.land/r/gnoland/wugnot",
  func: "Deposit",
  args: [],
  send: "1000ugnot",
  summary: "ignored"
};
test("approval describes actual Onyx costs in exact human units", () => {
  const message = approvalMessage(intent, preview, "test", "onyx-1", "g1wallet");
  for (const text of [
    "Deposit 0.001 test GNOT into wrapped GNOT",
    "Gas fee ceiling: 0.153727",
    "Storage deposit: 0.2061",
    "including the amount sent: 0.360827",
    "(Onyx testnet)",
    "Accept alone sends nothing",
    "Arguments (in order): []"
  ])
    assert.ok(message.includes(text), text);
  assert.ok(!message.includes('"gas_wanted"'));
  assert.equal(formatGnot("9223372036854775807"), "9223372036854.775807");
  assert.equal(formatGnot("1"), "0.000001");
});
test("unknown calls expose exact targets and arguments without inventing meaning", () => {
  const msg = approvalMessage(
    { ...intent, pkgpath: "gno.land/r/example/unknown", func: "Buy\nFAKE", args: ["100", "g1recipient"] },
    preview,
    "test",
    "gnoland-1",
    "g1wallet"
  );
  assert.ok(msg.includes("effects are not decoded"));
  assert.ok(msg.includes('"Buy\\nFAKE"'));
  assert.ok(msg.includes('["100","g1recipient"]'));
  assert.ok(!msg.includes("wrapped GNOT"));
  assert.ok(!msg.includes("test GNOT"));
});
test("incomplete, contradictory, overflowing or malformed cost information cannot authorize", () => {
  assert.equal(previewLimits({ ...preview, extra: { estimated_fee_ugnot: "1" } }), null);
  for (const [field, value] of [
    ["estimated_total_fee_ugnot", "153727"],
    ["storage_deposit_limit_ugnot", "0"],
    ["storage_deposit_limit_ugnot", "1"],
    ["estimated_storage_refund_ugnot", "-1"],
    ["estimated_fee_ugnot", "9223372036854775808"],
    ["estimated_storage_deposit_ugnot", "no"]
  ]) {
    assert.equal(previewLimits({ ...preview, extra: { ...preview.extra, [field]: value } }), null, field);
  }
  assert.equal(
    previewLimits({ ...preview, extra: { ...preview.extra, estimated_storage_refund_ugnot: "900000" } })
      .feeUgnot,
    "359827"
  );
});
test("unknown token precision and multiple sent coins are not guessed", () => {
  const msg = approvalMessage(
    { ...intent, pkgpath: "gno.land/r/example/x", send: "3other,1000ugnot" },
    preview,
    "test",
    "onyx-1",
    "g1wallet"
  );
  assert.ok(msg.includes('"3other,1000ugnot"'));
  assert.ok(msg.includes("excluding the sent coins above: 0.359827"));
});

test("the first three lines say what happens, what it costs and how to approve", () => {
  const form = approvalMessage(intent, preview, "test", "gnoland-1", "g1wallet").split("\n");
  assert.equal(form[0], "Deposit 0.001 GNOT into wrapped GNOT (wugnot).");
  assert.equal(form[1], "Costs up to 0.360827 GNOT in total: 0.001 GNOT sent, 0.153727 GNOT gas, up to 0.2061 GNOT storage deposit.");
  assert.match(form[2], /tick .Yes, sign and send this transaction.*then Accept/);
  const dialog = approvalMessage(intent, preview, "test", "gnoland-1", "g1wallet", "dialog").split("\n");
  assert.match(dialog[2], /click .Approve and send.\. Cancel sends nothing/);
  const unknown = approvalMessage({ ...intent, pkgpath: "gno.land/r/example/x", func: "Buy" }, preview, "t", "gnoland-1", "g1w").split("\n");
  assert.match(unknown[1], /^Costs up to/);
});
