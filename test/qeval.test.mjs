// gno_eval input validation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { invalidQeval } from "../dist/tools/chain.js";

test("accepts a call on a realm", () => {
  assert.equal(invalidQeval("gno.land/r/gnoswap/gns", "TotalSupply()"), null);
  assert.equal(invalidQeval("gno.land/r/demo/x", 'BalanceOf("g1abc")'), null);
});

test("rejects a pkgpath that is not a package path", () => {
  for (const p of ['gno.land/r/x").Other("', "gno.land/r/x;drop", "a b", ""]) {
    assert.ok(invalidQeval(p, "TotalSupply()"), `accepted pkgpath ${JSON.stringify(p)}`);
  }
});

test("rejects anything that is not a single call", () => {
  for (const e of [
    "TotalSupply(); Other()",
    "TotalSupply()\nOther()",
    "x = 1",
    "TotalSupply",
    "",
    "(TotalSupply())",
  ]) {
    assert.ok(invalidQeval("gno.land/r/demo/x", e), `accepted expr ${JSON.stringify(e)}`);
  }
});

test("rejects an oversized expression", () => {
  assert.ok(invalidQeval("gno.land/r/demo/x", `F("${"a".repeat(600)}")`));
});
