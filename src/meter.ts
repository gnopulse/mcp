/**
 * Usage metering for tools that call the chain or signer directly and so bypass
 * the REST API's own metering. Before such a tool runs, the caller's key is
 * checked against POST /api/mcp/meter. Hosted requests fail closed when usage authorization is unavailable. Local stdio
 * retains its public-RPC outage behavior.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";

export class Meter {
  constructor(private readonly cfg: Config) {}

  /** Returns null if the call may proceed, or the reason it was rejected. */
  async check(tool: string): Promise<string | null> {
    return (await this.authorize(tool)).error;
  }

  private async authorize(tool: string, completion?: { reservation: string; successful: boolean }): Promise<{ error: string | null; reservation?: string }> {
    // Local public-RPC tools have no hosted execution cost. REST-backed tools
    // still use their own API accounting through ApiClient.
    if (this.cfg.transport === "stdio") return { error: null };
    // Without a per-caller key there is nothing to meter.
    if (!this.cfg.apiKey)
      return { error: this.cfg.transport === "http" && this.cfg.requireApiKey ? "API key required" : null };
    let resp: Response;
    try {
      resp = await fetch(`${this.cfg.apiBase}/api/mcp/meter`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": this.cfg.apiKey,
          ...(this.cfg.meterServiceToken ? { "X-GP-Meter-Service": this.cfg.meterServiceToken } : {}) },
        body: JSON.stringify({ tool, action: completion ? "finish" : "reserve", ...completion }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs)
      });
    } catch {
      return { error: this.cfg.transport === "http" || completion
        ? "Usage authorization is temporarily unavailable. Retry shortly"
        : null };
    }
    if (resp.ok) {
      const verdict = (await resp.json().catch(() => null)) as { ok?: unknown; allowed?: unknown; reservation?: unknown; accounting_version?: unknown } | null;
      if (verdict?.ok !== true || verdict?.allowed !== true)
        return { error: "Usage authorization did not return a valid allowance. Retry shortly" };
      if (verdict.accounting_version === 2 && typeof verdict.reservation !== "string")
        return { error: "Usage authorization did not return a reservation. Retry shortly" };
      return { error: null, reservation: typeof verdict.reservation === "string" ? verdict.reservation : undefined };
    }
    const body = (await resp.json().catch(() => null)) as { reason?: unknown; retry_after?: unknown } | null;
    const retry = resp.headers.get("retry-after") ?? (body?.retry_after ? String(body.retry_after) : null);
    const credits = resp.headers.get("x-credits-remaining");
    const hint = [retry ? `retry after ${retry}s` : "", credits !== null ? `prepaid credits left: ${credits}` : ""]
      .filter(Boolean).join("; ");
    const reason = body?.reason ? String(body.reason) : `rate or quota limit (HTTP ${resp.status})`;
    return { error: hint ? `${reason} (${hint})` : reason };
  }

  async execute(tool: string, handler: () => unknown): Promise<unknown> {
    const admission = await this.authorize(tool);
    const failure = (reason: string) => ({ content: [{ type: "text", text: `Error: ${reason}.` }], isError: true });
    if (admission.error) return failure(admission.error);
    let result: unknown;
    try {
      result = await handler();
    } catch (error) {
      if (admission.reservation)
        await this.authorize(tool, { reservation: admission.reservation, successful: false });
      throw error;
    }
    if (admission.reservation) {
      const successful = !(result && typeof result === "object" && "isError" in result && result.isError);
      const completion = await this.authorize(tool, { reservation: admission.reservation, successful });
      if (completion.error) return failure(completion.error);
    }
    return result;
  }
}

/**
 * Wrap `server` so every tool registered through the returned proxy is metered
 * first. Use only for tools that do not already go through the REST API.
 */
export function metered(server: McpServer, meter: Meter): McpServer {
  const registerTool = (name: string, config: unknown, handler: (...args: any[]) => unknown) => {
    const wrapped = async (args: unknown, extra: unknown) => {
      return meter.execute(name, () => handler(args, extra));
    };
    return (server.registerTool as (...args: unknown[]) => unknown).call(server, name, config, wrapped);
  };

  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "registerTool") return registerTool;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
