/**
 * Client for the `gnotx serve` signing service. The private key stays in that
 * separate process; this server only asks it to simulate or execute calls.
 */
import type { Config } from "./config.js";

/** Response body shared by the service and the gnotx CLI. */
export interface GnotxEnvelope {
  mode?: "simulate" | "broadcast" | "query";
  caller?: string;
  func?: string;
  ok?: boolean;
  gas_used?: number;
  gas_wanted?: number;
  log?: string;
  return?: string[];
  tx_hash?: string;
  height?: number;
  extra?: Record<string, string>;
  error?: string;
}

/** GET /healthz response. */
export interface SignerHealth {
  ok?: boolean;
  caller?: string;
  chainid?: string;
  remotes?: string[];
  healthy_remote?: string;
}

export class SignerServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignerServiceError";
  }
}

/** Broadcasts wait for the block to commit, so they get a longer deadline than reads. */
const BROADCAST_TIMEOUT_FACTOR = 10;

export class Gnotx {
  constructor(private readonly cfg: Config) {}

  /** Simulate a MsgCall without broadcasting. */
  simulateCall(pkgpath: string, func: string, args?: string[], send?: string): Promise<GnotxEnvelope> {
    return this.post("/simulate", { pkgpath, func, args: args ?? [], send: send ?? "" });
  }

  /** Sign and broadcast a MsgCall. Callers must have passed policy and approval first. */
  broadcastCall(pkgpath: string, func: string, args?: string[], send?: string): Promise<GnotxEnvelope> {
    return this.post("/execute", { pkgpath, func, args: args ?? [], send: send ?? "" });
  }

  async health(): Promise<SignerHealth> {
    const resp = await fetch(`${this.cfg.signerServiceUrl}/healthz`, {
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    return (await resp.json()) as SignerHealth;
  }

  private async post(path: string, body: unknown): Promise<GnotxEnvelope> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.cfg.signerServiceToken) headers.Authorization = `Bearer ${this.cfg.signerServiceToken}`;

    let resp: Response;
    try {
      resp = await fetch(this.cfg.signerServiceUrl + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs * BROADCAST_TIMEOUT_FACTOR),
      });
    } catch (e) {
      throw new SignerServiceError(
        `signing service unreachable at ${this.cfg.signerServiceUrl} (is \`gnotx serve\` running?): ${String(e)}`,
      );
    }

    const text = await resp.text();
    const parsed = parseJson<GnotxEnvelope>(text);
    if (parsed?.error) throw new SignerServiceError(parsed.error);
    if (!resp.ok) throw new SignerServiceError(`signing service HTTP ${resp.status}: ${text.slice(0, 200)}`);
    if (!parsed) throw new SignerServiceError("signing service returned no parseable body");
    return parsed;
  }
}

function parseJson<T>(text: string): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
