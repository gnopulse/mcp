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
