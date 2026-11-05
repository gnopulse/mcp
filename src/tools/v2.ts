/** Indexer-backed tools for NFT ownership, wallet resources, Akkadia, trading signals, and pool detail. */
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
        "Cursor-paginated GRC721 NFTs a wallet owns across all collections. Includes " +
        "GnoSwap LP positions (each is an NFT). Prefer this over gno_grc721 for 'what does X own'.",
      inputSchema: {
        address: addressParam(),
        limit: z.number().int().min(1).max(1000).optional(),
        cursor: z.string().max(4096).optional().describe("next_cursor from the previous page for this wallet"),
      },
    },
    ({ address, limit, cursor }) => guard(async () => ok(await api.nftPageV2(`wallets/${seg(address)}/nfts`, { limit, cursor }))),
  );

  server.registerTool(
    "gno_nft_collection",
    {
      title: "NFT collection",
      description: "A GRC721 collection's holders, supply, and distribution.",
      inputSchema: { pkgpath: z.string().describe("full collection ID from gno_nft_holdings.by_collection, including the qualified token suffix") },
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
    "gno_wallet_token_transfers",
    {
      title: "Wallet token transfers",
      description:
        "A wallet's GRC20 token transfer history, newest first, cursor-paginated. Use gno_wallet_transfers for native GNOT and " +
        "gno_wallet_tokens for balances: this is history, not a balance source. issuer_verified=false means a non-standard " +
        "token library named the issuer or it was inferred from the called realm.",
      inputSchema: {
        address: addressParam(),
        token: z.string().optional().describe("limit to one token, as realm.SYMBOL or a bare realm"),
        limit: limitParam().default(50),
        cursor: z.string().optional().describe("next_cursor from a previous page"),
      },
    },
    ({ address, token, limit, cursor }) =>
      guard(async () => ok(await api.listV2(`wallets/${seg(address)}/token-transfers`, { token, limit, before: cursor }))),
  );

  server.registerTool(
    "gno_wallet_app_activity",
    {
      title: "Wallet app activity",
      description:
        "App actions ABOUT a wallet, including ones an operator signed for it, so players of operator-run games show up here " +
        "when they have no signed transactions. meta.apps_covered lists the apps indexed; an empty page says nothing about others.",
      inputSchema: {
        address: addressParam(),
        app: z.string().optional().describe("limit to one app, e.g. Akkadia"),
        limit: limitParam().default(50),
        cursor: z.string().optional().describe("next_cursor from a previous page"),
      },
    },
    ({ address, app, limit, cursor }) =>
      guard(async () => ok(await api.listV2(`wallets/${seg(address)}/app-activity`, { app, limit, before: cursor }))),
  );

  server.registerTool(
    "gno_wallet_storage",
    {
      title: "Wallet storage history",
      description: "Storage deposits and unlocks in transactions a wallet signed, with totals under summary, cursor-paginated.",
      inputSchema: {
        address: addressParam(),
        limit: limitParam(),
        cursor: z.string().optional().describe("next_cursor from a previous page"),
      },
    },
    ({ address, limit, cursor }) =>
      guard(async () => ok(await api.listV2(`wallets/${seg(address)}/storage`, { limit, before: cursor }))),
  );

  server.registerTool(
    "gno_wallet_sessions",
    {
      title: "Wallet session keys",
      description:
        "Session keys a wallet created: allowed paths, spend limits, expiry and status. Status comes from its own create " +
        "and revoke messages and the expiry, not a read of the chain's current session state.",
      inputSchema: { address: addressParam(), limit: limitParam() },
    },
    ({ address, limit }) => guard(async () => ok(await api.listV2(`wallets/${seg(address)}/sessions`, { limit }))),
  );

  // Realms and transactions

  server.registerTool(
    "gno_realm_calls",
    {
      title: "Realm calls",
      description:
        "A realm's calls with their arguments, newest first, cursor-paginated. Works for any realm, decoded by us or not: " +
        "arguments are what the chain recorded, and confidence says how much of the label is ours.",
      inputSchema: {
        path: z.string().describe("realm path, e.g. gno.land/r/gnoswap/router"),
        func: z.string().optional().describe("limit to one function"),
        success: z.enum(["0", "1"]).optional().describe("1=successful, 0=failed"),
        limit: limitParam(),
        cursor: z.string().optional().describe("next_cursor from a previous page"),
      },
    },
    ({ path, func, success, limit, cursor }) =>
      guard(async () => ok(await api.listV2(`realms/${seg(path)}/calls`, { func, success, limit, before: cursor }))),
  );

  server.registerTool(
    "gno_realm_events",
    {
      title: "Realm events",
      description:
        "Events a package emitted, with their attributes, newest first, cursor-paginated. Events are filed under the emitting " +
        "package, so token Transfer events sit under the token library; use gno_wallet_token_transfers for those.",
      inputSchema: {
        path: z.string().describe("package path"),
        func: z.string().optional().describe("limit to one event type, e.g. Bid"),
        limit: limitParam(),
        cursor: z.string().optional().describe("next_cursor from a previous page"),
      },
    },
    ({ path, func, limit, cursor }) =>
      guard(async () => ok(await api.listV2(`realms/${seg(path)}/events`, { func, limit, before: cursor }))),
  );

  server.registerTool(
    "gno_realm_storage",
    {
      title: "Realm storage history",
      description:
        "A package's storage deposits and unlocks, cursor-paginated. summary sets the indexed totals beside the chain's figure; " +
        "genesis packages hold bytes with no event behind them, reported as bytes_without_events.",
      inputSchema: {
        path: z.string().describe("package path"),
        limit: limitParam(),
        cursor: z.string().optional().describe("next_cursor from a previous page"),
      },
    },
    ({ path, limit, cursor }) => guard(async () => ok(await api.listV2(`realms/${seg(path)}/storage`, { limit, before: cursor }))),
  );

  server.registerTool(
    "gno_storage",
    {
      title: "Chain storage",
      description: "What the chain holds in storage: total bytes, deposits, price per byte and the largest packages.",
      inputSchema: {},
    },
    () => guard(async () => ok((await api.getV2("storage")).data)),
  );

  server.registerTool(
    "gno_transaction",
    {
      title: "Transaction",
      description: "One transaction by hash: its calls with arguments, events, token transfers and the raw record.",
      inputSchema: { hash: z.string().describe("transaction hash, as returned by other tools") },
    },
    ({ hash }) => guard(async () => ok((await api.getV2(`transactions/${seg(hash)}`)).data)),
  );

  // Akkadia

  server.registerTool(
    "gno_akkadia_stats",
    {
      title: "Akkadia stats",
      description: "Akkadia beta totals on mainnet: players, ABT minted, lotto tickets, and live realm counters.",
      inputSchema: {},
    },
    () => guard(async () => ok((await api.getV2("akkadia/stats")).data)),
  );

  server.registerTool(
    "gno_akkadia_players",
    {
      title: "Akkadia players",
      description: "Registered Akkadia players, oldest first, cursor-paginated.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional(),
        cursor: z.string().optional().describe("next_cursor from a previous page"),
      },
    },
    ({ limit, cursor }) => guard(async () => ok(await api.listV2("akkadia/players", { limit, before: cursor }))),
  );

  server.registerTool(
    "gno_akkadia_player",
    {
      title: "Akkadia player",
      description: "One Akkadia player: profile, live ABT balance and their activity, with a cursor over the activity.",
      inputSchema: {
        address: addressParam(),
        limit: limitParam(),
        cursor: z.string().optional().describe("meta.next_cursor from a previous call"),
      },
    },
    ({ address, limit, cursor }) =>
      guard(async () => {
        const { data, meta } = await api.getV2(`akkadia/players/${seg(address)}`, { limit, before: cursor });
        return ok({ ...data, next_cursor: meta.next_cursor ?? null, has_more: meta.has_more ?? false });
      }),
  );

  server.registerTool(
    "gno_akkadia_activity",
    {
      title: "Akkadia activity",
      description: "Player actions across Akkadia, newest first, one row per call, cursor-paginated.",
      inputSchema: {
        limit: limitParam(),
        cursor: z.string().optional().describe("next_cursor from a previous page"),
      },
    },
    ({ limit, cursor }) => guard(async () => ok(await api.listV2("akkadia/activity", { limit, before: cursor }))),
  );

  server.registerTool(
    "gno_akkadia_catalog",
    {
      title: "Akkadia item catalog",
      description: "Item definitions from Akkadia's on-chain catalog, with rarity, stats and art.",
      inputSchema: {
        type: z.string().optional().describe("item type, e.g. block or equipment"),
        rarity: z.string().optional().describe("normal, uncommon, rare, unique or legendary"),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    ({ type, rarity, limit, offset }) =>
      guard(async () => ok(await api.listV2("akkadia/catalog", { type, rarity, limit, offset }))),
  );

  server.registerTool(
    "gno_akkadia_worlds",
    {
      title: "Akkadia worlds",
      description: "Game worlds created on chain. Empty because the chain holds none yet, not because of an outage.",
      inputSchema: {
        limit: limitParam(),
        offset: z.number().int().min(0).optional(),
      },
    },
    ({ limit, offset }) => guard(async () => ok(await api.listV2("akkadia/worlds", { limit, offset }))),
  );

  server.registerTool(
    "gno_akkadia_lotto",
    {
      title: "Akkadia lotto owners",
      description: "Who holds tickets for one Akkadia lotto number, read live from the chain.",
      inputSchema: {
        number: z.number().int().min(0).describe("lotto number"),
        limit: z.number().int().min(1).max(100).optional(),
        after: z.string().optional().describe("next_after from a previous page"),
      },
    },
    ({ number, limit, after }) => guard(async () => ok((await api.getV2(`akkadia/lotto/${number}`, { limit, after })).data)),
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
      title: "Pool liquidity contributions and owners",
      description: "Indexed contributions, raw amounts and nullable current-price estimates, with separately verified current position owners. Events page by before; contributors page by offset.",
      inputSchema: { pool: z.string().describe("pool path/id"), limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).max(100000).optional(), before: z.string().optional() },
    },
    ({ pool, limit, offset, before }) => guard(async () => {
      const result = await api.getV2(`pools/${seg(pool)}/lp-providers`, { limit, offset, before });
      // Retain the existing items bundle while exposing its independent paging.
      return ok({ items: result.data, next_cursor: result.data?.next_cursor ?? null,
        has_more: result.data?.events_has_more ?? false,
        contributors_has_more: result.data?.has_more ?? false,
        next_offset: result.data?.has_more ? (result.data.offset ?? offset ?? 0) + (result.data.limit ?? limit ?? 100) : null,
        quota: result.meta.quota });
    }),
  );
}
