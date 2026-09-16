/**
 * Signer and PolicyEngine interfaces.
 *
 * Execution tools never hold a key. They build an `Intent`, check it against the
 * `PolicyEngine`, and pass it to the active `Signer`. Custody backends differ only in the
 * Signer implementation:
 *   - requiresApproval = true: the tool returns a preview and a token; a human calls
 *     gno_confirm before anything is broadcast.
 *   - requiresApproval = false: the intent is broadcast as soon as policy allows it.
 */

/** GnoSwap ExactInSwapRoute parameters. */
export interface SwapParams {
  tokenIn: string;
  tokenOut: string;
  /** Exact input amount, raw units. */
  amountIn: string;
  /** Slippage floor, raw output units. */
  minOut: string;
  /** Single-hop fee tier (100, 500, 3000, 10000). Defaults to 500. */
  fee?: string;
  /** Explicit route "in:out:fee"; overrides the single-hop route. */
  route?: string;
  /** Seconds until the swap expires. Defaults to 120. */
  deadlineSecs?: number;
}

/** A proposed on-chain action, produced by an execution tool before signing. */
export interface Intent {
  kind: "call" | "swap" | "approve" | "deploy";
  pkgpath?: string;
  func?: string;
  args?: string[];
  /** Coins sent with the message, e.g. "1000000ugnot". */
  send?: string;
  swap?: SwapParams;
  approve?: { token: string; spender: string; amount: string };
  deploy?: { pkgpath: string };
  /** One-line human-readable summary for approval prompts and logs. */
  summary: string;
}

/** A denial carries a reason the agent can act on. */
export type PolicyDecision = { allow: true } | { allow: false; reason: string };

/** Checked for every intent at propose time and again at confirm time. */
export interface PolicyEngine {
  check(intent: Intent): Promise<PolicyDecision> | PolicyDecision;
}

export interface ExecResult {
  ok: boolean;
  txHash?: string;
  height?: number;
  log?: string;
  returnValues?: string[];
}

export interface Signer {
  /** Short label for logs and capability reporting, e.g. "user-approval". */
  kind: string;
  /** True if a human must confirm each transaction. */
  requiresApproval: boolean;
  execute(intent: Intent): Promise<ExecResult>;
}

/** Policy that denies every intent. */
export const DENY_ALL: PolicyEngine = {
  check: () => ({ allow: false, reason: "no PolicyEngine configured; execution disabled (simulate-only)" }),
};
