// parseAminoAccount: raw auth/accounts response to balances and account fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAminoAccount } from "../dist/tools/util.js";

test("parses a BaseAccount into balances and account fields", () => {
  const raw = JSON.stringify({
    BaseAccount: {
      address: "g1account",
      coins: "1024483062ugnot,500grc",
      public_key: { "@type": "/tm.PubKeySecp256k1" },
      account_number: "42",
      sequence: "7",
    },
  });
  const a = parseAminoAccount(raw);
  assert.equal(a.address, "g1account");
  assert.deepEqual(a.balances, [
    { denom: "ugnot", amount: "1024483062" },
    { denom: "grc", amount: "500" },
  ]);
  assert.equal(a.account_number, "42");
  assert.equal(a.sequence, "7");
  assert.deepEqual(a.public_key, { "@type": "/tm.PubKeySecp256k1" });
});

test("empty coins yields no balances", () => {
  const a = parseAminoAccount(JSON.stringify({ BaseAccount: { address: "g1x", coins: "", account_number: "0", sequence: "0" } }));
  assert.deepEqual(a.balances, []);
  assert.equal(a.account_number, "0");
});

test("accepts an unwrapped account object too", () => {
  const a = parseAminoAccount(JSON.stringify({ address: "g1y", coins: "10ugnot", account_number: "1", sequence: "2" }));
  assert.deepEqual(a.balances, [{ denom: "ugnot", amount: "10" }]);
  assert.equal(a.address, "g1y");
});

test("non-JSON input yields null", () => {
  assert.equal(parseAminoAccount("account g1... not found"), null);
});

test("null or a primitive yields null", () => {
  assert.equal(parseAminoAccount("null"), null);
  assert.equal(parseAminoAccount("42"), null);
});
