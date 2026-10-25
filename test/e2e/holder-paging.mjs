import { check, run, serverEnv, startMock, startStdioClient } from "./lib.mjs";
await run(async () => {
  const holders = Array.from({ length: 39 }, (_, i) => ({ address: `wallet${i}`, balance: i + 1 }));
  let requests = 0;
  const api = await startMock((req) => {
    const u = new URL(req.url, "http://localhost");
    const offset = Number(u.searchParams.get("offset") || 0),
      limit = Number(u.searchParams.get("limit") || 5);
    requests++;
    return {
      data: {
        token_path: "example.PERUN",
        holders: holders.slice(offset, offset + limit),
        holder_count: 39,
        offset,
        limit,
        has_more: offset + limit < 39,
        partial: false,
        summary: "retained"
      },
      meta: {}
    };
  });
  const client = await startStdioClient(serverEnv({ GNOPULSE_SIGNER: "none", GNOPULSE_API_BASE: api.url }));
  try {
    const seen = [];
    let offset = 0;
    for (let i = 0; i < 10; i++) {
      const p = await client.callTool("gno_token_holders", { token: "example.PERUN", limit: 5, offset });
      check(
        "bundle and source completeness remain available",
        p.items.summary === "retained" && p.items.partial === false
      );
      check("reported total is not page length", p.total === 39);
      seen.push(...p.items.holders.map((x) => x.address));
      if (!p.has_more) {
        check("last page has no continuation", p.next_offset === null);
        break;
      }
      check(
        "continuation advances by actual returned rows",
        p.next_offset === offset + p.items.holders.length && p.next_offset > offset
      );
      offset = p.next_offset;
    }
    check(
      "a real MCP client reads all 39 holders, once each",
      seen.length === 39 && new Set(seen).size === 39
    );
    check("scan uses eight bounded pages", requests === 8);
  } finally {
    client.close();
    api.close();
  }
});
