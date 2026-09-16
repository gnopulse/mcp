/**
 * GRC20 and GRC721 tools, read directly from the chain.
 *
 * GRC20 metadata is not uniformly callable on token realms, so it is read through the GRC20
 * registry: `<registry>.Get("<key>").GetName()` and so on. Balances are exact on-chain reads.
 *
 * GRC721 realms do not share a uniform interface, so gno_grc721 tries the standard getters
 * and reports what resolves.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RpcClient } from "../rpc.js";
import { absentToNull, guard, ok, parseGnoScalar, type GnoScalar } from "./util.js";

// Tokens whose on-chain GetDecimals() is a placeholder, mapped to their display decimals.
// Keyed by realm path. Some registries key tokens as "<realm path>.<symbol>", so lookups
// also match by that prefix.
const DECIMALS_OVERRIDE: Record<string, number> = {
  "gno.land/r/gnoland/wugnot": 6,
  "gno.land/r/gnoswap/gov/xgns": 6,
};

function decimalsOverrideFor(token: string): number | undefined {
  for (const [realm, decimals] of Object.entries(DECIMALS_OVERRIDE)) {
    if (token === realm || token.startsWith(`${realm}.`)) return decimals;
  }
  return undefined;
}

// Registry renders link each entry as "<registry name>[/version]:<key>".
const REGISTRY_KEY_RE = /grc20reg(?:\/[^:\s]*)?:([^)\s]+)/g;

const quote = (s: string) => JSON.stringify(s);

export function registerTokenTools(server: McpServer, rpc: RpcClient, registry: string): void {
  const readToken = async (key: string, expr: string): Promise<GnoScalar> =>
    parseGnoScalar(absentToNull(await rpc.qeval(`${registry}.Get(${quote(key)}).${expr}`)));

  server.registerTool(
    "gno_token_registry",
    {
      title: "List GRC20 tokens",
      description:
        "List every GRC20 token in the on-chain GRC20 registry. Returns the token keys expected by " +
        "gno_token_metadata and gno_token_balance. New and IBC tokens register themselves here.",
      inputSchema: {},
    },
    () =>
      guard(async () => {
        const render = absentToNull(await rpc.qrender(registry, ""));
        if (!render) return ok({ registry, count: 0, tokens: [] });
        const keys = [...new Set([...render.matchAll(REGISTRY_KEY_RE)].map((m) => m[1]))];
        return ok({ registry, count: keys.length, tokens: keys });
      }),
  );

  server.registerTool(
    "gno_token_metadata",
    {
      title: "GRC20 token metadata",
      description:
        "Name, symbol, decimals, and total supply for a GRC20 token, read via the registry. " +
        "On-chain decimals can be a placeholder (e.g. wugnot reports 0 but uses 6); use " +
        "gno_prices for authoritative display decimals and USD price.",
      inputSchema: {
        token: z
          .string()
          .describe(
            "The exact key string from gno_token_registry output; do not construct it. The key " +
              "format varies by chain (a bare realm path, or \"<realm path>.<symbol>\"), and a wrong " +
              "key returns nulls rather than an error.",
          ),
      },
    },
    ({ token }) =>
      guard(async () => {
        const [name, symbol, decimals, totalSupply] = await Promise.all([
          readToken(token, "GetName()"),
          readToken(token, "GetSymbol()"),
          readToken(token, "GetDecimals()"),
          readToken(token, "TotalSupply()"),
        ]);
        const override = decimalsOverrideFor(token);
        const overridden = override !== undefined && override !== decimals;
        return ok({
          token,
          name,
          symbol,
          decimals: override ?? decimals,
          ...(overridden ? { decimals_onchain: decimals } : {}),
          total_supply: totalSupply,
          source: "grc20reg (on-chain)",
          decimals_note: overridden
            ? `on-chain GetDecimals() = ${decimals} (placeholder); corrected to ${override} to match gno_prices`
            : "on-chain value; use gno_prices for authoritative display decimals + price",
        });
      }),
  );

  server.registerTool(
    "gno_token_balance",
    {
      title: "GRC20 balance",
      description:
        "Exact on-chain GRC20 balance of an address, in raw units (divide by 10^decimals). " +
        "For native ugnot use gno_get_balances.",
      inputSchema: {
        token: z.string().describe("the exact key string from gno_token_registry output (see gno_token_metadata)"),
        address: z.string().describe("g1… address"),
      },
    },
    ({ token, address }) =>
      guard(async () => {
        const balance = await readToken(token, `BalanceOf(${quote(address)})`);
        return ok({ token, address, balance_raw: balance, note: "raw units; divide by 10^decimals" });
      }),
  );

  server.registerTool(
    "gno_grc721",
    {
      title: "GRC721 NFT (best-effort)",
      description:
        "Best-effort read of a GRC721 NFT realm via its standard getters. Null fields mean the realm " +
        "does not expose that getter. Pass owner for a balance and/or tokenId for owner and URI. " +
        "To list the NFTs an address owns, use gno_nft_holdings.",
      inputSchema: {
        pkgpath: z.string().describe("NFT realm pkgpath"),
        tokenId: z.string().optional().describe("a token id → owner + tokenURI"),
        owner: z.string().optional().describe("g1… address → NFT balance"),
      },
    },
    ({ pkgpath, tokenId, owner }) =>
      guard(async () => {
        const tryEval = async (expr: string): Promise<GnoScalar> => {
          try {
            return parseGnoScalar(absentToNull(await rpc.qeval(`${pkgpath}.${expr}`)));
          } catch {
            return null;
          }
        };
        const out: Record<string, unknown> = {
          pkgpath,
          best_effort: true,
          note: "null fields mean the realm does not expose that standard getter",
          name: (await tryEval("GetName()")) ?? (await tryEval("Name()")),
          symbol: (await tryEval("GetSymbol()")) ?? (await tryEval("Symbol()")),
        };
        if (owner) out.balance = await tryEval(`BalanceOf(${quote(owner)})`);
        if (tokenId) {
          out.owner_of = await tryEval(`OwnerOf(${quote(tokenId)})`);
          out.token_uri =
            (await tryEval(`TokenURI(${quote(tokenId)})`)) ?? (await tryEval(`GetTokenURI(${quote(tokenId)})`));
        }
        return ok(out);
      }),
  );
}
