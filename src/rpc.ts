/**
 * gno.land RPC client with failover across endpoints. ABCI `vm/*` queries take
 * hex-encoded data and return base64 in `result.response.ResponseBase.Data`.
 */
import type { Config } from "./config.js";

export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcError";
  }
}

/**
 * The chain answered but returned no value. `reason` holds the node's log when it
 * reported an error (for example "package not found").
 */
export interface Absent {
  readonly absent: true;
  readonly reason?: string;
}

export function isAbsent(v: unknown): v is Absent {
  return typeof v === "object" && v !== null && (v as Absent).absent === true;
}

interface AbciResponseBase {
  Error?: unknown;
  Data?: string | null;
  Log?: string;
}

const toHex = (s: string): string => Buffer.from(s, "utf8").toString("hex");

export class RpcClient {
  private readonly urls: string[];
  private readonly timeoutMs: number;
  /** Index of the last endpoint that answered; tried first next time. */
  private preferred = 0;

  constructor(cfg: Config) {
    this.urls = cfg.rpcUrls;
    this.timeoutMs = cfg.timeoutMs;
  }

  /** vm/qeval: evaluate a read-only expression, e.g. `gno.land/r/x.Foo("a")`. */
  async qeval(expr: string): Promise<string | Absent> {
    return decode(await this.abciQuery("vm/qeval", expr));
  }

  /** vm/qrender: a realm's Render(path) output. */
  async qrender(pkgpath: string, renderPath = ""): Promise<string | Absent> {
    return decode(await this.abciQuery("vm/qrender", `${pkgpath}:${renderPath}`));
  }

  /** vm/qfile: a package's file list (newline-separated) or a single file's source. */
  async qfile(pkgpath: string): Promise<string | Absent> {
    return decode(await this.abciQuery("vm/qfile", pkgpath));
  }

  /** vm/qfuncs: a package's exported function signatures as JSON. */
  async qfuncs(pkgpath: string): Promise<string | Absent> {
    return decode(await this.abciQuery("vm/qfuncs", pkgpath));
  }

  /** auth/accounts/<address>: the raw account (number, sequence, coins). */
  async authAccount(address: string): Promise<string | Absent> {
    return decode(await this.abciQuery(`auth/accounts/${address}`));
  }

  /** /status: node info and latest block. */
  async status(): Promise<any> {
    const json = await this.getWithFailover("/status");
    return json?.result ?? {};
  }

  private async abciQuery(path: string, data?: string): Promise<AbciResponseBase> {
    let query = `/abci_query?path=%22${encodeURIComponent(path)}%22`;
    if (data !== undefined) query += `&data=0x${toHex(data)}`;
    const json = await this.getWithFailover(query);
    return json?.result?.response?.ResponseBase ?? {};
  }

  /**
   * GET `pathAndQuery` from each endpoint in turn, starting at the preferred one.
   * Only transport failures fail over; a chain-level error is a valid answer.
   */
  private async getWithFailover(pathAndQuery: string): Promise<any> {
    const n = this.urls.length;
    let lastErr: unknown = null;
    for (let i = 0; i < n; i++) {
      const idx = (this.preferred + i) % n;
      try {
        const json = await this.getJson(this.urls[idx] + pathAndQuery);
        this.preferred = idx;
        return json;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new RpcError(`all ${n} RPC endpoint(s) failed for ${pathAndQuery}: ${String(lastErr)}`);
  }

  private async getJson(url: string): Promise<any> {
    const resp = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!resp.ok) throw new RpcError(`HTTP ${resp.status}`);
    return resp.json();
  }
}

function decode(rb: AbciResponseBase): string | Absent {
  if (rb.Error) {
    // The log is the error message followed by a Go stack trace; keep only the message.
    const log = typeof rb.Log === "string" ? rb.Log.trim() : "";
    const reason = log ? log.split("Stack Trace:")[0].trim() || log : undefined;
    return { absent: true, reason };
  }
  if (!rb.Data) return { absent: true };
  return Buffer.from(rb.Data, "base64").toString("utf8");
}
