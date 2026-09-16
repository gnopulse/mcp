/**
 * Data and analytics tools backed by the GnoPulse v2 REST API (`/api/v2/*`): resource paths,
 * cursor pagination, structured errors.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api.js";
import { guard, ok, pathSegment as seg } from "./util.js";

const limitParam = (max: number) => z.number().int().min(1).max(max).optional();

export function registerReadTools(server: McpServer, api: ApiClient): void {
  // Chain data

  server.registerTool(
    "gno_get_account",
    {
      title: "Account / wallet stats",
      description: "Wallet overview for a g1… address: activity, counts, labels.",
      inputSchema: { address: z.string().describe("g1… bech32 address") },
    },
    ({ address }) => guard(async () => ok((await api.getV2(`wallets/${seg(address)}/stats`)).data)),
  );

  server.registerTool(
    "gno_get_transactions",
    {
      title: "Transaction feed",
      description:
        "Recent classified transactions, newest first, cursor-paginated. Filter by app label or success. " +
        "For a specific wallet's activity use gno_wallet_transfers.",
      inputSchema: {
        app: z.string().optional().describe("filter by app label, e.g. GnoSwap"),
        success: z.enum(["0", "1"]).optional().describe("1=successful, 0=failed"),
        limit: limitParam(200).default(50),
        cursor: z.string().optional().describe("next_cursor from a previous page"),
      },
    },
    ({ app, success, limit, cursor }) =>
      guard(async () => ok(await api.listV2("transactions", { app, success, limit, before: cursor }))),
  );

  server.registerTool(
    "gno_get_block",
    {
      title: "Get block",
      description: "Block detail by height: transactions, proposer, time.",
      inputSchema: { height: z.number().int().describe("block height") },
    },
    ({ height }) => guard(async () => ok((await api.getV2(`blocks/${height}`)).data)),
  );

  server.registerTool(
    "gno_get_events",
    {
      title: "Get events",
      description: "Emitted Gno events grouped by realm and type, with filters.",
      inputSchema: {
        type: z.string().optional().describe("event type/name"),
        app: z.string().optional().describe("app label"),
        q: z.string().optional().describe("free-text (realm/pkgpath)"),
        limit: limitParam(200).default(50),
      },
    },
    ({ type, app, q, limit }) =>
      guard(async () => ok(await api.listV2("events", { event_type: type, app, q, limit }))),
  );

  server.registerTool(
    "gno_get_package",
    {
      title: "Get realm/package",
      description: "Realm or package detail: metadata, deployer, functions.",
      inputSchema: { pkgpath: z.string().describe("e.g. gno.land/r/gnoswap/router") },
    },
    ({ pkgpath }) => guard(async () => ok((await api.getV2(`realms/${seg(pkgpath)}`)).data)),
  );

  server.registerTool(
    "gno_search",
    {
      title: "Search",
      description: "Full-text search across realms, tokens, wallets, transactions, and blocks.",
      inputSchema: {
        query: z.string().describe("free-text query"),
        limit: limitParam(100),
      },
    },
    ({ query, limit }) => guard(async () => ok((await api.getV2("search", { q: query, limit })).data)),
  );

  // Tokens and DEX

  server.registerTool(
    "gno_token_holders",
    {
      title: "Token holders",
      description: "Holder distribution for a GRC20 token.",
      inputSchema: {
        token: z.string().describe("GRC20 token pkgpath"),
        limit: limitParam(500).default(100),
      },
    },
    ({ token, limit }) => guard(async () => ok(await api.listV2(`tokens/${seg(token)}/holders`, { limit }))),
  );

  server.registerTool(
    "gno_prices",
    {
      title: "Token prices",
      description: "Token prices sourced from GnoSwap. Pass a token for one price, or omit it for all.",
      inputSchema: { token: z.string().optional().describe("token pkgpath; omit for the whole feed") },
    },
    ({ token }) =>
      guard(async () => ok((await api.getV2(token ? `tokens/${seg(token)}/price` : "prices")).data)),
  );

  server.registerTool(
    "gno_ohlcv",
    {
      title: "Token candles (OHLCV)",
      description: "OHLCV candles for a token.",
      inputSchema: {
        token: z.string().describe("token pkgpath"),
        interval: z.string().optional().describe("e.g. 1h, 1d"),
        limit: limitParam(1000),
      },
    },
    ({ token, interval, limit }) =>
      guard(async () => ok((await api.getV2(`tokens/${seg(token)}/candles`, { interval, limit })).data)),
  );

  server.registerTool(
    "gno_pools",
    {
      title: "DEX pools",
      description:
        "GnoSwap pools with TVL, volume, and APR. For a single pool use gno_pool_depth, " +
        "gno_pool_lp_providers, or gno_ohlcv.",
      inputSchema: { limit: limitParam(500) },
    },
    ({ limit }) => guard(async () => ok(await api.listV2("pools", { limit }))),
  );

  // Analytics

  server.registerTool(
    "gno_smart_money",
    {
      title: "Smart money",
      description: "Wallets ranked by realized PnL.",
      inputSchema: { limit: limitParam(200) },
    },
    ({ limit }) => guard(async () => ok((await api.getV2("smart-money", { limit })).data)),
  );

  server.registerTool(
    "gno_mev",
    {
      title: "MEV activity",
      description: "Detected MEV activity: sandwiches and arbitrage.",
      inputSchema: { limit: limitParam(200) },
    },
    ({ limit }) => guard(async () => ok((await api.getV2("mev", { limit })).data)),
  );

  server.registerTool(
    "gno_holder_series",
    {
      title: "Holder-count series",
      description: "Holder-count time series for a token.",
      inputSchema: { token: z.string().describe("token pkgpath") },
    },
    ({ token }) => guard(async () => ok((await api.getV2(`tokens/${seg(token)}/holder-series`)).data)),
  );

  server.registerTool(
    "gno_launch_radar",
    {
      title: "Launch radar",
      description: "Newly launched tokens and pools.",
      inputSchema: { limit: limitParam(200) },
    },
    ({ limit }) => guard(async () => ok(await api.listV2("launches", { limit }))),
  );

  server.registerTool(
    "gno_label",
    {
      title: "Label address",
      description: "Resolve an address to known entity and app labels (e.g. GnoSwap, faucet).",
      inputSchema: { address: z.string().describe("g1… address") },
    },
    ({ address }) => guard(async () => ok((await api.getV2(`wallets/${seg(address)}/labels`)).data)),
  );

  server.registerTool(
    "gno_whales",
    {
      title: "Whales",
      description: "Largest whale-labeled wallets by net worth, excluding contracts.",
      inputSchema: { limit: limitParam(500) },
    },
    ({ limit }) => guard(async () => ok((await api.getV2("whales", { limit })).data)),
  );

  server.registerTool(
    "gno_dev_activity",
    {
      title: "Dev activity",
      description: "Recent launches with creator holdings and creator-sell (rug) signals.",
      inputSchema: {},
    },
    () => guard(async () => ok((await api.getV2("dev-activity")).data)),
  );
}
