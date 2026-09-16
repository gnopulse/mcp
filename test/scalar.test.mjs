// parseGnoScalar: `(value type)` output from vm/qeval.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGnoScalar } from "../dist/tools/util.js";

test("strings", () => {
  assert.equal(parseGnoScalar('("wugnot" string)'), "wugnot");
  assert.equal(parseGnoScalar('("wrapped GNOT" string)'), "wrapped GNOT");
  assert.equal(parseGnoScalar('("" string)'), "");
});

test("ints of various widths", () => {
  assert.equal(parseGnoScalar("(0 int)"), 0);
  assert.equal(parseGnoScalar("(3000000 int64)"), 3000000);
  assert.equal(parseGnoScalar("(42 uint64)"), 42);
  assert.equal(parseGnoScalar("(-7 int)"), -7);
});

test("big ints kept exact as strings", () => {
  const big = "90071992547409910"; // above Number.MAX_SAFE_INTEGER
  assert.equal(parseGnoScalar(`(${big} int64)`), big);
});

test("bools", () => {
  assert.equal(parseGnoScalar("(true bool)"), true);
  assert.equal(parseGnoScalar("(false bool)"), false);
});

test("null, empty, and unrecognized input", () => {
  assert.equal(parseGnoScalar(null), null);
  assert.equal(parseGnoScalar(""), null);
  assert.equal(parseGnoScalar("weird"), "weird");
});
