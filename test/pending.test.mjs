import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ApiClient } from "../dist/api.js";
import { loadConfig } from "../dist/config.js";

// A cold wallet answers {tokens: [], pending: true} first; that placeholder must never reach the agent.
const PENDING = { data: { address: "g1x", tokens: [], source: "live", pending: true }, meta: { pending: true, retry_after: 1 } };
const READY = { data: { address: "g1x", tokens: [{ token_path: "gno.land/r/gnoland/wugnot.wugnot", balance_raw: 5 }] }, meta: {} };

async function serve(answers, budgetMs, callback) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(answers[Math.min(calls++, answers.length - 1)]));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await callback(new ApiClient({ ...loadConfig(), apiBase: `http://127.0.0.1:${server.address().port}` }, budgetMs), () => calls);
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test("a pending answer is retried until the real result arrives", async () => {
  await serve([PENDING, READY], 10_000, async (api, calls) => {
    const { data } = await api.getV2("wallets/g1x/tokens");
    assert.equal(data.tokens.length, 1);
    assert.equal(calls(), 2);
  });
});

test("a result still pending at the deadline is an error, not an empty list", async () => {
  await serve([PENDING], 500, async api => {
    await assert.rejects(api.getV2("wallets/g1x/tokens"), err => err.code === "pending" && /still computing/.test(err.message));
  });
});
