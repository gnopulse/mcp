import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { ApiClient } from "../dist/api.js";
import { loadConfig } from "../dist/config.js";

// A refusal must say when to retry and what is left, or an agent cannot pace itself or see the cutoff.
async function refuse(status, headers, error, check) {
  const server = http.createServer((req, res) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify({ data: null, meta: { schema_version: 2 }, error }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await check(new ApiClient({ ...loadConfig(), apiBase: `http://127.0.0.1:${server.address().port}` }));
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test("a rate-limit refusal carries its retry time", async () => {
  await refuse(429, { "Retry-After": "7" }, { code: "rate_limited", message: "Rate limit exceeded" }, async api => {
    await assert.rejects(api.getV2("blocks"), err => err.code === "rate_limited" && /retry after 7s/.test(err.message));
  });
});

test("an empty prepaid balance is named with what is left of each limit", async () => {
  await refuse(402, { "X-Credits-Remaining": "0", "X-Quota-Daily-Remaining": "40708" },
    { code: "insufficient_credits", message: "Insufficient prepaid credits" }, async api => {
      await assert.rejects(api.getV2("prices"), err =>
        /prepaid credits left: 0/.test(err.message) && /daily units left: 40708/.test(err.message));
    });
});
