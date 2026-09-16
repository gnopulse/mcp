/** Server configuration, read from the environment with gnoland-1 mainnet defaults. */

/** Public gnoland-1 RPC endpoints, tried in order. Override with GNO_RPC_URLS (comma-separated). */
export const DEFAULT_RPC_URLS = ["https://rpc.onbloc.xyz", "https://gnoland-mainnet-rpc.corenodehq.xyz"];

export interface Config {
  /** GnoPulse REST API base URL. */
  apiBase: string;
  /** API key sent as X-API-Key. */
  apiKey?: string;
  /** RPC endpoints for ABCI queries, in failover order. */
  rpcUrls: string[];
  chainId: string;
  /** GRC20 registry realm path. */
  grc20Registry: string;
  /** Base URL of the `gnotx serve` signing service. */
  signerServiceUrl: string;
  /** Bearer token for the signing service. */
  signerServiceToken?: string;
  /** Per-request timeout for API and RPC calls, in milliseconds. */
  timeoutMs: number;
  transport: "stdio" | "http";
  httpHost: string;
  httpPort: number;
  /** HTTP transport: reject sessions that do not present an API key. */
  requireApiKey: boolean;
}

const env = (name: string): string | undefined => process.env[name] || undefined;

const trimSlashes = (url: string): string => url.replace(/\/+$/, "");

const envList = (name: string): string[] | undefined =>
  env(name)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig(): Config {
  return {
    apiBase: trimSlashes(env("GNOPULSE_API_BASE") ?? "https://gnopulse.xyz"),
    apiKey: env("GNOPULSE_API_KEY"),
    rpcUrls: envList("GNO_RPC_URLS") ?? DEFAULT_RPC_URLS,
    chainId: env("GNO_CHAIN_ID") ?? "gnoland-1",
    grc20Registry: env("GNO_GRC20_REGISTRY") ?? "gno.land/r/nt/grc20reg/v0",
    signerServiceUrl: trimSlashes(env("GNOTX_SERVICE_URL") ?? "http://127.0.0.1:8787"),
    signerServiceToken: env("GNOTX_SERVICE_TOKEN"),
    timeoutMs: Number(env("GNOPULSE_MCP_TIMEOUT_MS") ?? 15000),
    transport: env("GNOPULSE_MCP_TRANSPORT") === "http" ? "http" : "stdio",
    httpHost: env("GNOPULSE_MCP_HOST") ?? "127.0.0.1",
    httpPort: Number(env("GNOPULSE_MCP_PORT") ?? 8080),
    requireApiKey: env("GNOPULSE_MCP_REQUIRE_KEY") === "1",
  };
}

/** Return `cfg` with a per-session API key, or `cfg` itself when no key is given. */
export function withApiKey(cfg: Config, apiKey?: string): Config {
  return apiKey ? { ...cfg, apiKey } : cfg;
}
