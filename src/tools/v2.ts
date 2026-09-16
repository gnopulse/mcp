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
      description: "Detected wash-trading activity.",
      inputSchema: { limit: limitParam() },
    },
    ({ limit }) => guard(async () => ok((await api.getV2("wash-trades", { limit })).data)),
  );

  server.registerTool(
    "gno_swap_signals",
    {
      title: "Swap signals",
      description: "Swap-derived trading signals: tick crossings and price impact.",
      inputSchema: { limit: limitParam() },
    },
    ({ limit }) => guard(async () => ok((await api.getV2("signals/swaps", { limit })).data)),
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
