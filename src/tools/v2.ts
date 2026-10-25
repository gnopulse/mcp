/** Indexer-backed tools for NFT ownership, wallet resources, trading signals, and pool detail. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api.js";
import { guard, ok, pathSegment as seg } from "./util.js";

const addressParam = () => z.string().describe("g1… address");
const limitParam = () => z.number().int().min(1).max(200).optional();

export function registerV2Tools(server: McpServer, api: ApiClient): void {
  // NFTs

  server.registerTool(
    "gno_nft_holdings",
    {
      title: "NFT holdings",
      description:
        "Every GRC721 NFT a wallet owns across all collections, grouped by collection. Includes " +
        "GnoSwap LP positions (each is an NFT). Prefer this over gno_grc721 for 'what does X own'.",
      inputSchema: { address: addressParam() },
    },
    ({ address }) => guard(async () => ok(await api.listV2(`wallets/${seg(address)}/nfts`))),
  );

  server.registerTool(
    "gno_nft_collection",
    {
      title: "NFT collection",
      description: "A GRC721 collection's holders, supply, and distribution.",
      inputSchema: { pkgpath: z.string().describe("collection realm pkgpath, e.g. gno.land/r/gnoswap/gnft") },
    },
    ({ pkgpath }) => guard(async () => ok((await api.getV2(`nft/collections/${seg(pkgpath)}`)).data)),
  );

  // Wallets

  server.registerTool(
    "gno_wallet_pnl",
    {
      title: "Wallet PnL",
      description: "Realized and unrealized PnL for a wallet across its trades.",
      inputSchema: { address: addressParam() },
    },
    ({ address }) => guard(async () => ok((await api.getV2(`wallets/${seg(address)}/pnl`)).data)),
  );

  server.registerTool(
    "gno_wallet_transfers",
    {
      title: "Wallet transfers",
      description: "A wallet's incoming and outgoing coin transfers, newest first, cursor-paginated.",
      inputSchema: {
        address: addressParam(),
        limit: limitParam().default(50),
        cursor: z.string().optional().describe("next_cursor from a previous page"),
      },
    },
    ({ address, limit, cursor }) =>
      guard(async () => ok(await api.listV2(`wallets/${seg(address)}/transfers`, { limit, before: cursor }))),
  );

  server.registerTool(
    "gno_wallet_tokens",
    {
      title: "Wallet tokens",
      description: "A wallet's current GRC20 token balances.",
      inputSchema: { address: addressParam() },
    },
    ({ address }) => guard(async () => ok((await api.getV2(`wallets/${seg(address)}/tokens`)).data)),
  );

  // Signals

  server.registerTool(
    "gno_wash_trades",
    {
      title: "Wash trades",
      description: "Transaction-netted round-trip activity. Heuristic only, not proof of wash trading or common ownership.",
      inputSchema: { limit: limitParam(), days: z.union([z.literal(1), z.literal(7), z.literal(30)]).optional(), offset: z.number().int().min(0).max(100000).optional() },
    },
    ({ limit, days, offset }) => guard(async () => ok((await api.getV2("wash-trades", { limit, days, offset })).data)),
  );

  server.registerTool(
    "gno_swap_signals",
    {
      title: "Swap signals",
      description: "Settled swap events with price impact. Page with cursor=next_cursor; offset is retained for compatibility. Optionally filter by pool or signing wallet.",
      inputSchema: { limit: limitParam(), cursor: z.string().max(2048).optional(), offset: z.number().int().min(0).max(100000).optional(), trader: z.string().optional(), pool: z.string().optional() },
    },
    ({ limit, cursor, offset, trader, pool }) => guard(async () => {
      if (cursor && offset) throw new Error("Use cursor or offset, not both.");
      const { data } = await api.getV2("signals/swaps", { limit, before: cursor, offset, trader, pool });
      if (cursor && !Object.prototype.hasOwnProperty.call(data ?? {}, "next_cursor")) {
        throw new Error("This API does not support settled-swap cursor paging. Use a compatible API release or restart with offset paging.");
      }
      return ok(data);
    }),
  );

  // Pools

  server.registerTool(
    "gno_pool_depth",
    {
      title: "Pool depth",
      description: "Liquidity depth profile for a GnoSwap pool.",
      inputSchema: { pool: z.string().describe("pool path/id") },
    },
    ({ pool }) => guard(async () => ok((await api.getV2(`pools/${seg(pool)}/depth`)).data)),
  );

  server.registerTool(
    "gno_pool_lp_providers",
    {
      title: "Pool LP providers",
      description: "Liquidity providers for a GnoSwap pool.",
      inputSchema: { pool: z.string().describe("pool path/id") },
    },
    ({ pool }) => guard(async () => ok(await api.listV2(`pools/${seg(pool)}/lp-providers`))),
  );
}
