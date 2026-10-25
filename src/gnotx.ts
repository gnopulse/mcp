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
  unsigned_simulation?: boolean;
  keyless?: boolean;
  execution_enabled?: boolean;
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

/** Identity mismatch must never be treated as an ordinary backend outage. */
export class SignerIdentityError extends SignerServiceError {}

/** Broadcasts wait for the block to commit, so they get a longer deadline than reads. */
const BROADCAST_TIMEOUT_FACTOR = 10;

export class Gnotx {
  constructor(private readonly cfg: Config) {}

  /** Simulate a MsgCall without broadcasting. */
  async simulateCall(
    pkgpath: string,
    func: string,
    args?: string[],
    send?: string,
    caller?: string,
    publicKey?: string
  ): Promise<GnotxEnvelope> {
    await this.requireCapability(false);
    return this.post("/simulate", {
      pkgpath,
      func,
      args: args ?? [],
      send: send ?? "",
      caller,
      public_key: publicKey
    });
  }

  /** Sign and broadcast a MsgCall. Callers must have passed policy and approval first. */
  async broadcastCall(
    pkgpath: string,
    func: string,
    args?: string[],
    send?: string,
    limits?: { gasWanted: number; feeUgnot: string; storageDepositUgnot: string }
  ): Promise<GnotxEnvelope> {
    await this.requireCapability(true);
    return this.post("/execute", {
      pkgpath,
      func,
      args: args ?? [],
      send: send ?? "",
      max_gas_wanted: limits?.gasWanted,
      max_fee_ugnot: limits?.feeUgnot,
      max_storage_deposit_ugnot: limits?.storageDepositUgnot
    });
  }

  private async requireCapability(execute: boolean): Promise<void> {
    const h = await this.verifiedHealth();
    if (!h.ok || h.chainid !== this.cfg.chainId || h.unsigned_simulation !== true)
      throw new SignerServiceError(
        "A healthy unsigned simulation service on the configured chain is required. No signed fallback is allowed."
      );
    if (this.cfg.transport === "http" && (h.keyless !== true || h.execution_enabled !== false))
      throw new SignerServiceError("Hosted simulation requires a keyless backend with execution disabled.");
    if (execute && (!this.cfg.agentId || !this.cfg.agentAddress || h.execution_enabled !== true))
      throw new SignerServiceError("Agent identity and explicit service execution permission are required.");
  }

  async verifiedHealth(): Promise<SignerHealth> {
    const h = await this.health();
    if (h.chainid !== this.cfg.chainId)
      throw new SignerIdentityError("Service chain does not match the configured chain.");
    if (this.cfg.agentAddress && h.caller !== this.cfg.agentAddress)
      throw new SignerIdentityError("Service wallet does not match the configured agent wallet.");
    return h;
  }

  async health(): Promise<SignerHealth> {
    const resp = await fetch(`${this.cfg.signerServiceUrl}/healthz`, {
      signal: AbortSignal.timeout(this.cfg.timeoutMs)
    });
    if (!resp.ok) throw new SignerServiceError("Simulation service health check failed.");
    return (await resp.json()) as SignerHealth;
  }

  private async post(path: string, body: unknown): Promise<GnotxEnvelope> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (this.cfg.signerServiceToken) headers.Authorization = `Bearer ${this.cfg.signerServiceToken}`;

    let resp: Response;
    try {
      resp = await fetch(this.cfg.signerServiceUrl + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs * BROADCAST_TIMEOUT_FACTOR)
      });
    } catch (e) {
      throw new SignerServiceError(
        `signing service unreachable at ${this.cfg.signerServiceUrl} (is \`gnotx serve\` running?): ${String(e)}`
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
