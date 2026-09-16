/**
 * Autonomous signer: once the policy allows an intent, it is broadcast without human
 * confirmation. The key stays in the gnotx signing service. Because the policy is the only
 * gate, this signer must be paired with a restrictive policy (allowlist, send cap, fees-only,
 * or default-deny).
 */
import type { Gnotx } from "../gnotx.js";
import type { ExecResult, Intent, Signer } from "./types.js";
import { broadcastIntent } from "./execute.js";

export class MicroserviceSigner implements Signer {
  readonly kind = "microservice";
  readonly requiresApproval = false;

  constructor(private readonly gnotx: Gnotx) {}

  execute(intent: Intent): Promise<ExecResult> {
    return broadcastIntent(this.gnotx, intent);
  }
}
