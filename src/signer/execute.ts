/** Intent-to-broadcast logic shared by every signer backed by the gnotx signing service. */
import type { Gnotx, GnotxEnvelope } from "../gnotx.js";
import type { ExecResult, Intent, SwapParams } from "./types.js";

export const GNOSWAP_ROUTER = "gno.land/r/gnoswap/router";

const DEFAULT_FEE_TIER = "500";
const DEFAULT_DEADLINE_SECS = 120;

export function toResult(env: GnotxEnvelope): ExecResult {
  return { ok: !!env.ok, txHash: env.tx_hash, height: env.height, log: env.log, returnValues: env.return };
}

/**
 * Arguments for router.ExactInSwapRoute: tokenIn, tokenOut, amountIn, route, quote, minOut,
 * deadline, referrer. Build this immediately before simulating or broadcasting, since the
 * deadline is relative to now.
 */
export function swapCallArgs(s: SwapParams): string[] {
  const fee = s.fee ?? DEFAULT_FEE_TIER;
  const route = s.route ?? `${s.tokenIn}:${s.tokenOut}:${fee}`;
  const deadline = String(Math.floor(Date.now() / 1000) + (s.deadlineSecs ?? DEFAULT_DEADLINE_SECS));
  return [s.tokenIn, s.tokenOut, s.amountIn, route, "100", s.minOut, deadline, ""];
}

/** Sign and broadcast an intent that has already passed policy (and approval, if required). */
export async function broadcastIntent(gnotx: Gnotx, intent: Intent): Promise<ExecResult> {
  switch (intent.kind) {
    case "call":
      return toResult(await gnotx.broadcastCall(intent.pkgpath!, intent.func!, intent.args, intent.send));
    case "approve": {
      const { token, spender, amount } = intent.approve!;
      return toResult(await gnotx.broadcastCall(token, "Approve", [spender, amount]));
    }
    case "swap":
      return toResult(await gnotx.broadcastCall(GNOSWAP_ROUTER, "ExactInSwapRoute", swapCallArgs(intent.swap!)));
    case "deploy":
      throw new Error(
        "Deploy is not supported by the signer: it requires MsgAddPackage and a signed CLA " +
          "(gno.land/r/sys/cla). Use gno_deploy for the requirements.",
      );
    default:
      throw new Error(`Unsupported intent kind "${(intent as Intent).kind}"`);
  }
}
