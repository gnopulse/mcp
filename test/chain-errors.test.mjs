import { test } from "node:test";
import assert from "node:assert/strict";
import { readableReason } from "../dist/rpc.js";
import { registerChainTools } from "../dist/tools/chain.js";

const NOT_FOUND = "--= Error =--\nData: vm.InvalidPkgPathError{abciError:vm.abciError{}}\nMsg Traces:\n" +
  "    0  /gnoroot/gno.land/pkg/sdk/vm/errors.go:88 - package not found: gno.land/r/gnoland/home\n--= /Error =--";
const BAD_ADDRESS = "--= Error =--\nData: std.InvalidAddressError{abciError:std.abciError{}}\nMsg Traces:\n" +
  "    0  /gnoroot/tm2/pkg/std/errors.go:96 - invalid query address notanaddress\n--= /Error =--";

function tools(rpc) {
  const handlers = {};
  registerChainTools({ registerTool(name, _config, fn) { handlers[name] = fn; } }, rpc);
  return handlers;
}
const rejected = log => ({ absent: true, reason: readableReason(log) });

test("node logs reduce to the message a caller can act on", () => {
  assert.equal(readableReason(NOT_FOUND), "package not found: gno.land/r/gnoland/home");
  assert.equal(readableReason("plain message"), "plain message");
});

test("a render of a missing package is a tool error", async () => {
  const r = await tools({ qrender: async () => rejected(NOT_FOUND) }).gno_render({ pkgpath: "gno.land/r/gnoland/home", path: "" });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "Error: package not found: gno.land/r/gnoland/home");
});

test("an empty render stays a result", async () => {
  const r = await tools({ qrender: async () => ({ absent: true }) }).gno_render({ pkgpath: "gno.land/r/x", path: "" });
  assert.equal(r.isError, undefined);
});

test("a malformed address is a tool error, not an empty balance", async () => {
  const r = await tools({ authAccount: async () => rejected(BAD_ADDRESS) }).gno_get_balances({ address: "notanaddress" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /invalid query address notanaddress/);
});

test("an address with no account is still a zero-balance fact", async () => {
  const r = await tools({ authAccount: async () => ({ absent: true }) }).gno_get_balances({ address: "g1unused" });
  assert.equal(r.isError, undefined);
  assert.deepEqual(JSON.parse(r.content[0].text).balances, []);
});

test("a rejected eval and an unknown package listing are tool errors", async () => {
  const t = tools({ qeval: async () => rejected(NOT_FOUND), qfile: async () => rejected(NOT_FOUND), qfuncs: async () => rejected(NOT_FOUND) });
  assert.equal((await t.gno_eval({ pkgpath: "gno.land/r/gnoland/home", expr: "Name()" })).isError, true);
  assert.equal((await t.gno_package_files({ pkgpath: "gno.land/r/gnoland/home" })).isError, true);
});
