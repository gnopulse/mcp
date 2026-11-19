/**
 * Tells the agent, and through it the user, when this server is out of date.
 *
 * Setup pins an exact version (`@gnopulse/mcp@X.Y.Z`), so nothing updates on its own. Two signals:
 * - a newer release on npm, checked once at startup (GNOPULSE_MCP_UPDATE_CHECK=0 turns it off);
 * - the chain refusing a transaction's encoding, which means the bundled signer is too old for the
 *   chain. gno nodes word that refusal as "non-canonical encoding" / "upgrade your client".
 * Both arrive as an extra text item on write and status tool results, never as a failure.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "./version.js";

const REGISTRY = "https://registry.npmjs.org/@gnopulse/mcp/latest";
const CHECK_TIMEOUT_MS = 3000;
const CLIENT_TOO_OLD = /non-canonical encoding|upgrade your client/i;

/** Numeric x.y.z comparison; a prerelease or malformed version never counts as newer. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split(".").map(Number) : null);
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export class UpdateNotices {
  latest: string | null = null;
  private shown = false;

  constructor(readonly current: string = VERSION) {}

  /** Ask npm for the latest release. Never throws; offline or slow just means no notice. */
  async check(fetchImpl: typeof fetch = fetch): Promise<void> {
    try {
      const res = await fetchImpl(REGISTRY, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
      });
      if (!res.ok) return;
      const body = (await res.json()) as { version?: unknown };
      if (typeof body.version === "string" && isNewer(body.version, this.current)) this.latest = body.version;
    } catch {
      /* no notice */
    }
  }

  private howTo(): string {
    const target = this.latest ?? "latest";
    return (
      `In this app's MCP settings, change @gnopulse/mcp@${this.current} to @gnopulse/mcp@${target} and restart ` +
      "the app. The agent wallet and its recovery backup stay as they are."
    );
  }

  /** The notice to add to one tool result, if any. */
  noticeFor(tool: string, resultText: string): string | null {
    if (CLIENT_TOO_OLD.test(resultText)) {
      this.shown = true;
      return (
        `UPDATE REQUIRED: the chain refused this transaction's encoding because this GnoPulse MCP ` +
        `(v${this.current}) is older than the chain requires. Nothing was sent. Tell the user: ${this.howTo()}`
      );
    }
    if (!this.latest) return null;
    // Status is where an agent looks first; elsewhere say it once per session, not on every call.
    if (tool !== "gno_agent_status" && this.shown) return null;
    this.shown = true;
    return `GnoPulse MCP v${this.latest} is available (this is v${this.current}). Mention it to the user: ${this.howTo()}`;
  }
}

type ToolResultLike = { content?: { type: string; text?: string }[] };

/** Wrap registerTool so each handler's result can carry a notice. */
export function withUpdateNotices(server: McpServer, notices: UpdateNotices): McpServer {
  const registerTool = (name: string, config: unknown, handler: (...args: any[]) => unknown) => {
    const wrapped = async (args: unknown, extra: unknown) => {
      const result = (await handler(args, extra)) as ToolResultLike;
      if (!result || !Array.isArray(result.content)) return result;
      const text = result.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");
      const notice = notices.noticeFor(name, text);
      return notice ? { ...result, content: [...result.content, { type: "text", text: notice }] } : result;
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
