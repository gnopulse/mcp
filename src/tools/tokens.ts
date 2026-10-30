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

function decimalsOverrideFor(token: string, chainId: string): number | undefined {
  if (!["gnoland-1", "onyx-1"].includes(chainId)) return undefined;
  for (const [realm, decimals] of Object.entries(DECIMALS_OVERRIDE)) {
    if (chainId === "onyx-1" && realm !== "gno.land/r/gnoland/wugnot") continue;
    if (token === realm || token.startsWith(`${realm}.`)) return decimals;
  }
  return undefined;
}

// Registry renders link each entry as "<registry name>[/version]:<key>".
const REGISTRY_KEY_RE = /grc20reg(?:\/[^:\s]*)?:([^)\s]+)/g;

const quote = (s: string) => JSON.stringify(s);

/**
 * Token keys as the registry spells them. A bare realm that registers exactly one token
 * resolves to that token's key; a full key, or any token when the registry is unreadable,
 * passes through unchanged.
 */
export function tokenKeys(rpc: RpcClient, registry: string) {
  const list = async (): Promise<string[] | null> => {
    const render = absentToNull(await rpc.qrender(registry, ""));
    return render === null ? null : [...new Set([...render.matchAll(REGISTRY_KEY_RE)].map((m) => m[1]))];
  };
  const resolve = async (token: string): Promise<string> => {
    if (token.slice(token.lastIndexOf("/") + 1).includes(".")) return token;
    const keys = await list().catch(() => null);
    if (keys === null || keys.includes(token)) return token;
    const matches = keys.filter((k) => k.startsWith(`${token}.`));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1)
      throw new Error(`${token} registers several tokens (${matches.join(", ")}); pass one of those keys`);
    return token;
  };
  return { list, resolve };
}

export function registerTokenTools(server: McpServer, rpc: RpcClient, registry: string, chainId = "gnoland-1"): void {
  const readToken = async (key: string, expr: string): Promise<GnoScalar> =>
    parseGnoScalar(absentToNull(await rpc.qeval(`${registry}.Get(${quote(key)}).${expr}`)));

  const keys = tokenKeys(rpc, registry);
  const registryKeys = keys.list;

  // Accept what people type: native ugnot is refused with a pointer.
  const resolveKey = async (token: string): Promise<string> => {
    if (token === "ugnot" || token === "gnot")
      throw new Error("ugnot is native GNOT, not a GRC20 token; use gno_get_balances for balances and gno_prices for price");
    return keys.resolve(token);
  };

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
        const keys = await registryKeys();
        if (keys === null) throw new Error("Token registry is unavailable or unsupported on this network");
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
            "A key from gno_token_registry output (\"<realm path>.<symbol>\" on mainnet), or a realm " +
              "path that registers exactly one token, e.g. gno.land/r/gnoswap/gns.",
          ),
      },
    },
    ({ token: input }) =>
      guard(async () => {
        const token = await resolveKey(input);
        const [name, symbol, decimals, totalSupply] = await Promise.all([
          readToken(token, "GetName()"),
          readToken(token, "GetSymbol()"),
          readToken(token, "GetDecimals()"),
          readToken(token, "TotalSupply()"),
        ]);
        if ([name, symbol, decimals, totalSupply].some(value => value === null))
          throw new Error("Token metadata could not be verified for this identifier; use token registry discovery");
        const override = decimalsOverrideFor(token, chainId);
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
        token: z.string().describe("a gno_token_registry key, or a realm path that registers one token (see gno_token_metadata)"),
        address: z.string().describe("g1… address"),
      },
    },
    ({ token: input, address }) =>
      guard(async () => {
        const token = await resolveKey(input);
        const balance = await readToken(token, `BalanceOf(${quote(address)})`);
        if (balance === null) throw new Error("Token balance could not be verified; no zero balance is asserted");
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
          // Missing getters return Absent; transport failures must reach guard.
          return parseGnoScalar(absentToNull(await rpc.qeval(`${pkgpath}.${expr}`)));
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
        if (["name", "symbol", "balance", "owner_of", "token_uri"].every(key => out[key] == null))
          throw new Error("No standard NFT getter could be verified; collection existence is unknown");
        return ok(out);
      }),
  );
}
