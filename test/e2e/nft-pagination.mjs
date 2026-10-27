import { check, run, serverEnv, startMock, startStdioClient } from "./lib.mjs";

await run(async () => {
  let reads = 0;
  const mock = await startMock(req => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.endsWith("/nfts")) {
      reads++;
      const cursor = url.searchParams.get("cursor");
      const offset = cursor ? Number(cursor) : 0;
      const limit = Number(url.searchParams.get("limit") ?? 500);
      const items = Array.from({ length: Math.min(limit, 2620 - offset) }, (_, i) => ({ collection: "LP", token_id: String(offset+i), block_height: 100 }));
      const more = offset + items.length < 2620;
      return { data: items, meta: { total: 2620, limit, by_collection: { LP: 2620 }, has_more: more, next_cursor: more ? String(offset + items.length) : null } };
    }
    return { ok: true, allowed: true };
  });
  const client = await startStdioClient(serverEnv({ GNOPULSE_API_BASE: mock.url }));
  try {
    let cursor;
    const seen = new Set();
    do {
      const page = await client.callTool("gno_nft_holdings", { address: "g1test", limit: 137, ...(cursor ? { cursor } : {}) });
      check("whole owner total", page.total === 2620);
      check("collection total", page.by_collection?.LP === 2620);
      for (const row of page.items ?? []) seen.add(row.token_id);
      cursor = page.next_cursor;
      if (page.has_more !== !!cursor) throw new Error("contradictory continuation");
    } while (cursor);
    check("all NFTs reachable through actual MCP tool", seen.size === 2620);
    check("multiple API requests", reads === 20);
    const first = await client.callTool("gno_nft_holdings", { address: "g1test" });
    check("old address-only arguments remain supported", first.items.length === 500);
  } finally { client.close(); mock.close(); }
});
