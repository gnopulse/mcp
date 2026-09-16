/**
 * Usage metering for tools that call the chain or signer directly and so bypass
 * the REST API's own metering. Before such a tool runs, the caller's key is
 * checked against POST /api/mcp/meter. Metering fails open: if the endpoint is
 * unreachable the call proceeds.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";

export class Meter {
  constructor(private readonly cfg: Config) {}

  /** Returns null if the call may proceed, or the reason it was rejected. */
  async check(tool: string): Promise<string | null> {
    // Without a per-caller key there is nothing to meter.
    if (!this.cfg.apiKey) return null;
    let resp: Response;
    try {
      resp = await fetch(`${this.cfg.apiBase}/api/mcp/meter`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": this.cfg.apiKey },
        body: JSON.stringify({ tool }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch {
      return null;
    }
    if (resp.ok) return null;
    const body = (await resp.json().catch(() => null)) as { reason?: unknown } | null;
    return body?.reason ? String(body.reason) : `rate or quota limit (HTTP ${resp.status})`;
  }
}

/**
 * Wrap `server` so every tool registered through the returned proxy is metered
 * first. Use only for tools that do not already go through the REST API.
 */
export function metered(server: McpServer, meter: Meter): McpServer {
  const registerTool = (name: string, config: unknown, handler: (...args: any[]) => unknown) => {
    const wrapped = async (args: unknown, extra: unknown) => {
      const denied = await meter.check(name);
      if (denied) {
        return {
          content: [{ type: "text", text: `Error: ${denied}. Upgrade your plan or wait for the window to reset.` }],
          isError: true,
        };
      }
      return handler(args, extra);
    };
    return (server.registerTool as (...args: unknown[]) => unknown).call(server, name, config, wrapped);
  };

  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") return registerTool;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
