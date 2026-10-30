/** Concrete calls shared by policy, preview and execution. */
import type { Intent, SwapParams } from "./types.js";

export const GNOSWAP_ROUTER = "gno.land/r/gnoswap/router";

const DEFAULT_FEE_TIER = "500";
const DEFAULT_DEADLINE_SECS = 120;

/**
 * Arguments for router.ExactInSwapRoute: tokenIn, tokenOut, amountIn, route, quote, minOut,
 * deadline, referrer. Build this immediately before simulating or broadcasting, since the
 * deadline is relative to now.
 */
export function swapCallArgs(s: SwapParams): string[] {
  const fee = s.fee ?? DEFAULT_FEE_TIER;
  const route = s.route ?? `${s.tokenIn}:${s.tokenOut}:${fee}`;
  const deadline = String(s.deadline ?? Math.floor(Date.now() / 1000) + (s.deadlineSecs ?? DEFAULT_DEADLINE_SECS));
  return [s.tokenIn, s.tokenOut, s.amountIn, route, s.quote ?? "100", s.minOut, deadline, ""];
}

/** Derive targets from the operation rather than trusting duplicate metadata. */
export function targetForIntent(intent: Intent): { pkgpath?: string; func?: string } {
  switch (intent.kind) {
    case "swap":
      return { pkgpath: GNOSWAP_ROUTER, func: "ExactInSwapRoute" };
    case "approve":
      return { pkgpath: intent.approve?.token, func: "Approve" };
    case "deploy":
      return { pkgpath: intent.deploy?.pkgpath ?? intent.pkgpath, func: intent.func };
    default:
      return { pkgpath: intent.pkgpath, func: intent.func };
  }
}

export function callForIntent(intent: Intent): { pkgpath: string; func: string; args: string[]; send?: string } {
  if (intent.kind === "deploy")
    throw new Error("Deployment requires the separately authorized package deployment flow.");
  if (!["call", "swap", "approve"].includes(intent.kind)) throw new Error("Unsupported execution operation.");
  const target = targetForIntent(intent);
  if (!target.pkgpath || !target.func) throw new Error("A concrete realm and function are required.");
  if (intent.kind === "swap") {
    if (!intent.swap || !Number.isSafeInteger(intent.swap.deadline))
      throw new Error("A fixed swap deadline is required before policy or simulation.");
    return { ...target, pkgpath: target.pkgpath, func: target.func, args: swapCallArgs(intent.swap), send: undefined };
  }
  if (intent.kind === "approve") {
    if (!intent.approve) throw new Error("Allowance arguments are required.");
    return {
      pkgpath: target.pkgpath,
      func: target.func,
      args: [intent.approve.spender, intent.approve.amount],
      send: undefined
    };
  }
  return { pkgpath: target.pkgpath, func: target.func, args: intent.args ?? [], send: intent.send };
}
