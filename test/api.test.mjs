import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ApiClient } from "../dist/api.js";
import { loadConfig } from "../dist/config.js";

async function serve(body, callback) {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Quota-Daily-Remaining", "99");
    res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await callback(new ApiClient({ ...loadConfig(), apiBase: `http://127.0.0.1:${server.address().port}` }));
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test("bounded lists retain usable pagination and quota headers", async () => {
  await serve({ data: [{ id: 4 }], meta: { limit: 1, offset: 3, total: 5, has_more: true } }, async api => {
    const page = await api.listV2("events", { offset: 3 });
    assert.equal(page.offset, 3);
    assert.equal(page.next_offset, 4);
    assert.equal(page.quota["x-quota-daily-remaining"], "99");
  });
});

test("nested application errors do not become successful MCP data", async () => {
  await serve({ data: { ok: false, error: "router_disabled" }, error: null }, async api => {
    await assert.rejects(api.getV2("dex/route"), /router_disabled/);
  });
});

test("legacy HTTP-200 errors are surfaced", async () => {
  await serve({ error: "unsafe curve state" }, async api => {
    await assert.rejects(api.get("/api/launchpad/quote"), /unsafe curve state/);
  });
});

test("holder bundle preserves distribution and reports real continuation", async () => {
  const data = {
    holders: [{ address: "a" }, { address: "b" }],
    holder_count: 7,
    offset: 2,
    limit: 2,
    has_more: true,
    partial: true,
    cohorts: { whales: 1 }
  };
  await serve({ data, meta: {} }, async (api) => {
    const page = await api.holderPageV2("tokens/example/holders", { limit: 2, offset: 2 });
    assert.deepEqual(page.items, data);
    assert.equal(page.total, 7);
    assert.equal(page.has_more, true);
    assert.equal(page.next_offset, 4);
    assert.equal(page.quota["x-quota-daily-remaining"], "99");
  });
  await serve(
    { data: { ...data, holders: [{ address: "z" }], offset: 6, has_more: false }, meta: {} },
    async (api) => {
      const page = await api.holderPageV2("tokens/example/holders", { offset: 6, limit: 2 });
      assert.equal(page.has_more, false);
      assert.equal(page.next_offset, null);
    }
  );
});

test("holder continuation rejects malformed or stalled pages", async () => {
  const valid = { holders: [{ address: "a" }], holder_count: 2, offset: 0, limit: 1, has_more: true };
  for (const data of [
    { ...valid, has_more: false },
    { ...valid, holders: [] },
    { ...valid, holder_count: "2" },
    { ...valid, offset: -1 },
    { ...valid, holders: {} },
    { ...valid, limit: 0 },
    { ...valid, holder_count: 0, has_more: false },
    { ...valid, offset: Number.MAX_SAFE_INTEGER, holder_count: Number.MAX_SAFE_INTEGER, has_more: false }
  ]) {
    await serve({ data, meta: {} }, async (api) => {
      await assert.rejects(api.holderPageV2("tokens/example/holders"), /pagination/);
    });
  }
});

test("NFT continuation preserves whole-owner metadata and rejects incompatible APIs", async () => {
  const meta = { limit: 1, total: 2620, by_collection: { LP: 2620 }, has_more: true, next_cursor: "page2" };
  await serve({ data: [{ token_id: "1" }], meta }, async api => {
    const page = await api.nftPageV2("wallets/a/nfts", { limit: 1 });
    assert.equal(page.total, 2620);
    assert.equal(page.next_cursor, "page2");
    assert.deepEqual(page.by_collection, { LP: 2620 });
    assert.equal(page.quota["x-quota-daily-remaining"], "99");
  });
  for (const invalid of [
    { ...meta, next_cursor: undefined },
    { ...meta, next_cursor: null },
    { ...meta, next_cursor: 5 },
    { ...meta, has_more: false },
  ]) {
    await serve({ data: [{ token_id: "1" }], meta: invalid }, async api => {
      await assert.rejects(api.nftPageV2("wallets/a/nfts", { cursor: "page1" }), /pagination/);
    });
  }
  await serve({ data: [{ token_id: "1" }], meta }, async api => {
    await assert.rejects(api.nftPageV2("wallets/a/nfts", { cursor: "page2" }), /pagination/);
  });
  await serve({ data: [], meta: { ...meta, has_more: false, next_cursor: null } }, async api => {
    const page = await api.nftPageV2("wallets/a/nfts", { cursor: "last" });
    assert.equal(page.total, 2620);
    assert.equal(page.has_more, false);
  });
});
