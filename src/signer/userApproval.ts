/**
 * Human-approval signer: each transaction must be confirmed (gno_call, then gno_confirm) before
 * it is broadcast. Signing happens in the gnotx signing service; the key never reaches the MCP.
 */
import type { Gnotx } from "../gnotx.js";
import type { ExecResult, Intent, Signer } from "./types.js";
import { broadcastIntent } from "./execute.js";

export class UserApprovalSigner implements Signer {
  readonly kind = "user-approval";
  readonly requiresApproval = true;

  constructor(private readonly gnotx: Gnotx) {}

  execute(intent: Intent): Promise<ExecResult> {
    return broadcastIntent(this.gnotx, intent);
  }
}
