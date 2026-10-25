/** Intent-to-broadcast logic shared by every signer backed by gnotx. */
import type { Gnotx, GnotxEnvelope } from "../gnotx.js";
import type { ExecResult, Intent } from "./types.js";
import { callForIntent } from "./call.js";
export { GNOSWAP_ROUTER, swapCallArgs } from "./call.js";

export function toResult(env: GnotxEnvelope): ExecResult {
  return {
    ok: !!env.ok,
    txHash: env.tx_hash,
    height: env.height,
    log: env.log,
    returnValues: env.return
  };
}

/** Broadcast the same concrete call that passed policy and preview. */
export async function broadcastIntent(gnotx: Gnotx, intent: Intent): Promise<ExecResult> {
  const limits = intent.executionLimits;
  if (!limits) throw new Error("A bounded successful simulation is required before signing.");
  const call = callForIntent(intent);
  return toResult(await gnotx.broadcastCall(call.pkgpath, call.func, call.args, call.send, limits));
}
