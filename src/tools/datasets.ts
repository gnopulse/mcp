/** Tools for the rest of the v2 surface: explorer lists, chain datasets, DEX analytics and quotes, wallet DeFi. */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api.js";
import { guard, ok, pathSegment as seg } from "./util.js";

const limit = (max: number) => z.number().int().min(1).max(max).optional();
const offset = () => z.number().int().min(0).optional().describe("next_offset from the previous page");
const cursor = () => z.string().max(4096).optional().describe("next_cursor from the previous page");
const address = () => z.string().describe("g1… address");
const amount = () => z.string().regex(/^[0-9]{1,19}$/).describe("raw integer amount in the token's smallest unit");

export function registerDatasetTools(server: McpServer, api: ApiClient): void {
  const object = (name: string, title: string, description: string, path: string) =>
    server.registerTool(name, { title, description, inputSchema: {} },
      () => guard(async () => ok((await api.getV2(path)).data)));

  // Explorer

  server.registerTool("gno_blocks", {
    title: "Recent blocks",
    description: "Recent blocks, newest first, cursor-paginated. One block: gno_get_block.",
    inputSchema: { limit: limit(200), cursor: cursor() },
  }, ({ limit, cursor }) => guard(async () => ok(await api.listV2("blocks", { limit, before: cursor }))));

  server.registerTool("gno_realms", {
    title: "Realms and packages",
    description: "Indexed realms and packages with activity counts, offset-paged. For one package use gno_get_package.",
    inputSchema: { limit: limit(2000), offset: offset() },
  }, ({ limit, offset }) => guard(async () => ok(await api.listV2("realms", { limit, offset }))));

  server.registerTool("gno_functions", {
    title: "Function call stats",
    description: "How often each realm function is called, filterable by app label or a text match on the name.",
    inputSchema: { app: z.string().optional(), q: z.string().optional(), limit: limit(1000), offset: offset() },
  }, ({ app, q, limit, offset }) => guard(async () => ok(await api.listV2("functions", { app, q, limit, offset }))));

  server.registerTool("gno_failed_calls", {
    title: "Failed transactions",
    description: "Failed transactions with the raw chain error and an error class; filter by realm or class.",
    inputSchema: {
      realm: z.string().optional().describe("package path"), class: z.string().optional().describe("error class"),
      since_height: z.number().int().min(0).optional(), limit: limit(200), offset: offset(),
    },
  }, ({ realm, class: errorClass, since_height, limit, offset }) =>
    guard(async () => ok(await api.listV2("failed-calls", { realm, class: errorClass, since_height, limit, offset }))));

  server.registerTool("gno_realm_graph", {
    title: "Realm import graph",
    description: "Which realms and packages import which. scope=overview for the whole chain, ego with root for one package's neighbourhood.",
    inputSchema: {
      scope: z.enum(["overview", "ego"]).optional(), root: z.string().optional().describe("package path for scope=ego"),
      depth: z.number().int().min(1).max(2).optional(),
    },
  }, ({ scope, root, depth }) => guard(async () => ok((await api.getV2("realm-graph", { scope, root, depth })).data)));

  server.registerTool("gno_discoveries", {
    title: "Newly found packages",
    description: "Packages discovered on chain, newest first.",
    inputSchema: { limit: limit(1000), offset: offset() },
  }, ({ limit, offset }) => guard(async () => ok(await api.listV2("discoveries", { limit, offset }))));

  server.registerTool("gno_libraries", {
    title: "Libraries",
    description: "Pure packages (gno.land/p/...) with how many realms import them.",
    inputSchema: { include_audit: z.boolean().optional() },
  }, ({ include_audit }) => guard(async () => ok(await api.listV2("libraries", { include_audit: include_audit ? "1" : undefined }))));

  server.registerTool("gno_library", {
    title: "Library detail",
    description: "One library: event breakdown, the realms that call it and its deployment. Unknown paths are not_found.",
    inputSchema: { path: z.string().describe("gno.land/p/... path") },
  }, ({ path }) => guard(async () => ok((await api.getV2(`libraries/${seg(path)}`)).data)));

  object("gno_gpao_queue", "GPAO deploy queue",
    "Mainnet package-approval queue: waiting, enabled and blocked packages. Other networks answer unsupported_query.", "gpao/queue");

  server.registerTool("gno_gpao_package", {
    title: "GPAO package status",
    description: "One package's GPAO approval record; tracked=false when GPAO never saw it.",
    inputSchema: { path: z.string().describe("gno.land/... package path") },
  }, ({ path }) => guard(async () => ok((await api.getV2(`gpao/packages/${seg(path)}`)).data)));

  // Chain

  server.registerTool("gno_governance", {
    title: "GovDAO proposals",
    description: "GovDAO proposals, newest first, with per-tier voting power. Votes per proposal: gno_governance_votes.",
    inputSchema: { limit: limit(50) },
  }, ({ limit }) => guard(async () => ok((await api.getV2("governance/proposals", { limit })).data)));

  server.registerTool("gno_governance_votes", {
    title: "Proposal votes",
    description: "Votes cast on one GovDAO proposal.",
    inputSchema: { id: z.number().int().min(0).describe("proposal id") },
  }, ({ id }) => guard(async () => ok((await api.getV2(`governance/proposals/${id}/votes`)).data)));

  server.registerTool("gno_validators", {
    title: "Validators",
    description: "Validator set with voting power, share, recent uptime and registered valopers.",
    inputSchema: { uptime_blocks: z.number().int().min(1).max(100).optional() },
  }, ({ uptime_blocks }) => guard(async () => ok((await api.getV2("validators", { uptime_blocks })).data)));

  object("gno_bridges", "Bridges",
    "Every bridge stack (IBC, Union, Hyperlane): connected chains, clients, vouchers and escrow.", "bridges");

  server.registerTool("gno_bridge_transfers", {
    title: "Bridge transfers",
    description: "Cross-chain transfers across all bridge stacks, newest first, cursor-paginated.",
    inputSchema: { limit: limit(200), cursor: cursor() },
  }, ({ limit, cursor }) => guard(async () => ok(await api.listV2("bridges/transfers", { limit, before: cursor }))));

  server.registerTool("gno_wraps", {
    title: "GNOT wraps",
    description: "Standalone GNOT to wugnot wraps and unwraps, newest first.",
    inputSchema: { limit: limit(200) },
  }, ({ limit }) => guard(async () => ok((await api.getV2("wraps", { limit })).data)));

  object("gno_sparklines", "Activity sparklines", "Coarse activity buckets across the whole indexed range.", "sparklines");
  object("gno_health", "Indexer health", "Indexer and classifier health, chain tip versus indexed tip, and data freshness.", "health");

  // DEX

  object("gno_dex_analytics", "DEX analytics",
    "Venue and per-pool TVL, 24h/7d volume, fee and emission APR, and per-token volume. Costs expensive units.", "dex/analytics");

  server.registerTool("gno_dex_series", {
    title: "DEX volume series",
    description: "DEX volume over time for the whole venue or one pool.",
    inputSchema: {
      interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).optional(), days: z.number().int().min(1).max(3650).optional(),
      pool: z.string().optional().describe("pool key from gno_pools"),
    },
  }, ({ interval, days, pool }) => guard(async () => ok((await api.getV2("dex/series", { interval, days, pool })).data)));

  server.registerTool("gno_pool_ohlcv", {
    title: "Pool candles",
    description: "OHLCV candles for one pool's pair. For a token's candles across pools use gno_ohlcv.",
    inputSchema: {
      pool: z.string().describe("pool key from gno_pools"),
      interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).optional(), limit: limit(5000),
    },
  }, ({ pool, interval, limit }) => guard(async () => ok((await api.getV2(`pools/${seg(pool)}/ohlcv`, { interval, limit })).data)));

  server.registerTool("gno_pool_trades", {
    title: "Pool trades",
    description: "Recent settled swaps for one pool (the tape) plus whole-pool stats.",
    inputSchema: { pool: z.string().describe("pool key from gno_pools"), limit: limit(100) },
  }, ({ pool, limit }) => guard(async () => ok((await api.getV2("dex/pool-trades", { pool, limit })).data)));

  server.registerTool("gno_swap_hops", {
    title: "Multi-hop swaps",
    description: "Multi-hop swaps leg by leg, as executed.",
    inputSchema: {
      status: z.string().optional().describe("route status filter"), first_leg: z.boolean().optional(),
      limit: limit(1000), offset: offset(),
    },
  }, ({ status, first_leg, limit, offset }) =>
    guard(async () => ok(await api.listV2("dex/swap-hops", { status, first_leg: first_leg ? "1" : undefined, limit, offset }))));

  server.registerTool("gno_dex_quote", {
    title: "Swap quote",
    description: "Read-only GnoSwap router quote for a known route, fee included once. Find a route with gno_dex_route.",
    inputSchema: {
      in: z.string().describe("input token path"), out: z.string().describe("output token path"),
      amount: amount(), route: z.string().describe("route string from gno_dex_route"),
    },
  }, (args) => guard(async () => ok((await api.getV2("dex/quote", args)).data)));

  server.registerTool("gno_dex_route", {
    title: "Swap route",
    description: "Best route between two tokens from bounded direct and two-hop discovery; discloses its search scope.",
    inputSchema: { in: z.string().describe("input token path"), out: z.string().describe("output token path"), amount: amount() },
  }, (args) => guard(async () => ok((await api.getV2("dex/route", args)).data)));

  // Tokens and launches

  object("gno_token_directory", "Token directory",
    "Every token from every source with trust, price state (priced, quoted, no_market) and holder count.", "tokens");
  object("gno_price_list", "All token prices",
    "Every token's price (VWAP with oracle cross-check). One token: gno_prices. Costs expensive units.", "prices");

  server.registerTool("gno_launchpad", {
    title: "Launchpad markets",
    description: "Launch venue markets: bonding-curve launches with graduation progress and zDex pools.",
    inputSchema: { status: z.string().optional(), limit: limit(500) },
  }, ({ status, limit }) => guard(async () => ok((await api.getV2("launchpad", { status, limit })).data)));

  server.registerTool("gno_launch_quote", {
    title: "Launch quote",
    description: "Read-only bonding-curve quote. Unsafe curve states answer quote_unavailable instead of a number.",
    inputSchema: { token: z.string(), side: z.enum(["buy", "sell"]).optional(), amount: amount() },
  }, (args) => guard(async () => ok((await api.getV2("launchpad/quote", args)).data)));

  server.registerTool("gno_launch_snipers", {
    title: "Launch snipers",
    description: "Sniper activity on one launch pool.",
    inputSchema: { pool: z.string().describe("launch pool key from gno_launch_radar") },
  }, ({ pool }) => guard(async () => ok((await api.getV2(`launches/${seg(pool)}/snipers`)).data)));

  // Signals and wallets

  server.registerTool("gno_cvd", {
    title: "Cumulative volume delta",
    description: "Buy minus sell pressure over time for one token. Costs expensive units.",
    inputSchema: {
      token: z.string(), interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).optional(),
      days: z.number().int().min(1).max(3650).optional(),
    },
  }, ({ token, interval, days }) => guard(async () => ok((await api.getV2("cvd", { token, interval, days })).data)));

  server.registerTool("gno_wallet_flows", {
    title: "Wallet flows",
    description: "Wallets with repeated sizeable net flows over a window. Costs expensive units.",
    inputSchema: {
      days: z.number().int().min(1).max(90).optional(), min_trades: z.number().int().min(1).max(100).optional(),
      min_usd: z.number().int().min(0).optional(), limit: limit(500),
    },
  }, (args) => guard(async () => ok((await api.getV2("signals/flows", args)).data)));

  object("gno_known_entities", "Known entities", "Labeled entities such as whales, arbitrageurs and distributors.", "known-entities");

  server.registerTool("gno_wallet_defi", {
    title: "Wallet DeFi positions",
    description: "GnoSwap liquidity positions (held or staked), fees, rewards and delegated GNS. pending=true means retry after meta.retry_after.",
    inputSchema: { address: address() },
  }, ({ address }) => guard(async () => {
    const { data, meta } = await api.getV2(`wallets/${seg(address)}/defi`);
    return ok({ ...data, freshness: meta.freshness, valuation_complete: meta.valuation_complete,
      ...(meta.pending ? { pending: true, retry_after: meta.retry_after } : {}) });
  }));

  server.registerTool("gno_wallet_realms", {
    title: "Wallet realms",
    description: "Which realms a wallet has called, with counts.",
    inputSchema: { address: address(), limit: limit(1000), offset: offset() },
  }, ({ address, limit, offset }) => guard(async () => ok(await api.listV2(`wallets/${seg(address)}/realms`, { limit, offset }))));

  server.registerTool("gno_wallet_cluster", {
    title: "Wallet cluster",
    description: "Funding cluster for an address: wallets funded from the same source. A signal, not proof of common ownership.",
    inputSchema: { address: address() },
  }, ({ address }) => guard(async () => ok((await api.getV2(`wallets/${seg(address)}/cluster`)).data)));
}
