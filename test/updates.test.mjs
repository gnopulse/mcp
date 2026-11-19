import { test } from "node:test";
import assert from "node:assert/strict";
import { isNewer, UpdateNotices, withUpdateNotices } from "../dist/updates.js";

const REFUSED =
  '{"status":"simulate_failed","reason":"std.TxDecodeError: non-canonical encoding of std.Tx (upgrade your client to gno v1.7.1+)"}';

const registry = (version, ok = true) => async () => ({ ok, json: async () => ({ version }) });

function registered(notices, handler) {
  const tools = {};
  const fake = { registerTool(name, _config, fn) { tools[name] = fn; } };
  const server = withUpdateNotices(fake, notices);
  for (const name of ["gno_agent_status", "gno_call", "gno_simulate_call"]) server.registerTool(name, {}, handler);
  return tools;
}
const text = (r) => r.content.map((c) => c.text).join("\n");

test("only a higher release version counts as newer", () => {
  assert.equal(isNewer("0.3.12", "0.3.11"), true);
  assert.equal(isNewer("0.4.0", "0.3.11"), true);
  assert.equal(isNewer("0.3.11", "0.3.11"), false);
  assert.equal(isNewer("0.3.9", "0.3.11"), false);
  assert.equal(isNewer("0.4.0-rc.1", "0.3.11"), false);
  assert.equal(isNewer("garbage", "0.3.11"), false);
});

test("a newer npm release is noticed; an older, failed or offline check is not", async () => {
  const n = new UpdateNotices("0.3.11");
  await n.check(registry("0.3.12"));
  assert.equal(n.latest, "0.3.12");
  for (const f of [registry("0.3.11"), registry("0.3.12", false), async () => { throw new Error("offline"); }]) {
    const m = new UpdateNotices("0.3.11");
    await m.check(f);
    assert.equal(m.latest, null);
  }
});

test("a refused encoding tells the user to update, even with no npm answer", async () => {
  const tools = registered(new UpdateNotices("0.3.10"), async () => ({ content: [{ type: "text", text: REFUSED }], isError: true }));
  const r = await tools.gno_call({}, {});
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, REFUSED, "the original result is kept as it was");
  assert.match(r.content[1].text, /^UPDATE REQUIRED/);
  assert.match(r.content[1].text, /@gnopulse\/mcp@0\.3\.10 to @gnopulse\/mcp@latest/);
});

test("an available update shows on status every time and on other tools once", async () => {
  const n = new UpdateNotices("0.3.11");
  await n.check(registry("0.3.12"));
  const tools = registered(n, async () => ({ content: [{ type: "text", text: '{"status":"ready"}' }] }));
  assert.match(text(await tools.gno_simulate_call({}, {})), /v0\.3\.12 is available/);
  assert.equal((await tools.gno_call({}, {})).content.length, 1);
  assert.match(text(await tools.gno_agent_status({}, {})), /@gnopulse\/mcp@0\.3\.12/);
  assert.match(text(await tools.gno_agent_status({}, {})), /v0\.3\.12 is available/);
});

test("an up-to-date server adds nothing", async () => {
  const tools = registered(new UpdateNotices("0.3.12"), async () => ({ content: [{ type: "text", text: '{"status":"ready"}' }] }));
  assert.equal((await tools.gno_agent_status({}, {})).content.length, 1);
});
