// SessionStore bounds: LRU eviction at the cap and idle expiry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../dist/sessions.js";

const session = () => {
  const s = { closed: false, close: async () => void (s.closed = true) };
  return s;
};

test("evicts the least recently used session at the cap", () => {
  const store = new SessionStore(2, 1000, () => 0);
  const a = session();
  const b = session();
  const c = session();
  store.add("a", a);
  store.add("b", b);
  store.get("a");
  store.add("c", c);
  assert.equal(store.size, 2);
  assert.equal(b.closed, true);
  assert.equal(store.get("b"), undefined);
  assert.equal(store.get("a"), a);
  assert.equal(a.closed, false);
});

test("sweep closes only idle sessions", () => {
  let now = 0;
  const store = new SessionStore(10, 1000, () => now);
  const idle = session();
  const active = session();
  store.add("idle", idle);
  store.add("active", active);
  now = 900;
  store.get("active");
  now = 1500;
  store.sweep();
  assert.equal(idle.closed, true);
  assert.equal(active.closed, false);
  assert.equal(store.size, 1);
});

test("delete removes without closing", () => {
  const store = new SessionStore();
  const s = session();
  store.add("x", s);
  store.delete("x");
  assert.equal(store.size, 0);
  assert.equal(s.closed, false);
});
