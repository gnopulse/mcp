/**
 * Autonomous signer for a signing service that uses an external signer backend (local mnemonic
 * or Turnkey), selected in the service with GNOTX_TEE_PROVIDER.
 *
 * From the MCP side this is identical to MicroserviceSigner: it calls the same signing service
 * and never holds a key. The distinct `kind` exists for capability reporting.
 */
import type { Gnotx } from "../gnotx.js";
import type { ExecResult, Intent, Signer } from "./types.js";
import { broadcastIntent } from "./execute.js";

export class TeeSigner implements Signer {
  readonly kind = "tee";
  readonly requiresApproval = false;

  constructor(private readonly gnotx: Gnotx) {}

  execute(intent: Intent): Promise<ExecResult> {
    return broadcastIntent(this.gnotx, intent);
  }
}
