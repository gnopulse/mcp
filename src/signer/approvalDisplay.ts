import type { GnotxEnvelope } from "../gnotx.js";
import type { Intent } from "./types.js";
import { callForIntent } from "./call.js";
import { parseUgnot } from "./policy.js";

const INT64_MAX = 9223372036854775807n;
function amount(value: string | undefined): bigint | null {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const n = BigInt(value);
  return n <= INT64_MAX ? n : null;
}

/** An old gas-only backend must never issue a transaction approval. */
export function previewLimits(preview: GnotxEnvelope): Intent["executionLimits"] | null {
  const e = preview.extra;
  const gas = amount(e?.estimated_fee_ugnot);
  const deposit = amount(e?.estimated_storage_deposit_ugnot);
  const storage = amount(e?.storage_deposit_limit_ugnot);
  const refund = amount(e?.estimated_storage_refund_ugnot);
  const total = amount(e?.estimated_total_fee_ugnot);
  if (
    !Number.isSafeInteger(preview.gas_wanted) ||
    preview.gas_wanted! <= 0 ||
    gas === null ||
    gas === 0n ||
    deposit === null ||
    storage === null ||
    storage === 0n ||
    refund === null ||
    total === null ||
    deposit > storage ||
    gas + storage !== total
  )
    return null;
  return {
    gasWanted: preview.gas_wanted!,
    feeUgnot: total.toString(),
    storageDepositUgnot: storage.toString()
  };
}

export function formatGnot(ugnot: string | bigint): string {
  const n = BigInt(ugnot);
  const fraction = (n % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${n / 1000000n}${fraction ? `.${fraction}` : ""}`;
}

/** Deterministic descriptions of supported intents, never model-authored contract claims. */
export function approvalMessage(
  intent: Intent,
  preview: GnotxEnvelope,
  agent: string,
  chain: string,
  wallet: string
): string {
  const limits = previewLimits(preview);
  if (!limits) throw new Error("Complete cost information is required for approval.");
  const e = preview.extra!;
  const call = callForIntent(intent);
  const unit = chain === "onyx-1" ? "test GNOT" : "GNOT";
  const money = (n: string | bigint) => `${formatGnot(n)} ${unit}`;
  const send = parseUgnot(call.send);
  let action: string;
  if (intent.kind === "swap" && intent.swap) {
    action = `Request a swap of ${JSON.stringify(intent.swap.amountIn)} raw units of ${JSON.stringify(intent.swap.tokenIn)} with minimum requested output ${JSON.stringify(intent.swap.minOut)} raw units of ${JSON.stringify(intent.swap.tokenOut)}. Token decimals are not inferred.`;
  } else if (intent.kind === "approve" && intent.approve) {
    action = `Request a spending allowance of ${JSON.stringify(intent.approve.amount)} raw units for ${JSON.stringify(intent.approve.spender)} using token ${JSON.stringify(intent.approve.token)}. The token implementation determines the actual effects; they are not independently decoded.`;
  } else if (
    call.pkgpath === "gno.land/r/gnoland/wugnot" &&
    call.func === "Deposit" &&
    call.args.length === 0 &&
    send !== null
  ) {
    action = `Deposit ${money(send)} into wrapped GNOT (wugnot).`;
  } else {
    action = `Call ${JSON.stringify(call.func)} on realm ${JSON.stringify(call.pkgpath)}.\nThis contract's effects are not decoded. Review the arguments below; the call may change contract state or move tokens.`;
  }
  const total = BigInt(limits.feeUgnot);
  return [
    "Review transaction",
    action,
    `Network: ${JSON.stringify(chain)}${chain === "onyx-1" ? " (Onyx testnet)" : ""}`,
    `Agent: ${JSON.stringify(agent)}`,
    `From wallet: ${wallet}`,
    `Amount sent: ${send === null ? JSON.stringify(call.send || "") + " (native coin units)" : money(send)}`,
    `Gas fee ceiling: ${money(e.estimated_fee_ugnot)}`,
    `Storage deposit: ${money(e.estimated_storage_deposit_ugnot)} estimated; up to ${money(limits.storageDepositUgnot)} authorized. This locks funds for contract storage.`,
    `Maximum gas + storage debit: ${money(total)}`,
    `Maximum native debit${send === null ? " excluding the sent coins above" : " including the amount sent"}: ${money(total + (send ?? 0n))}`,
    `Estimated storage refund: ${money(e.estimated_storage_refund_ugnot)}. Refunds do not reduce these limits.`,
    "Simulation passed without signing. State may change; a failed submitted transaction can still consume gas. Contract effects and token transfers are not bounded by the gas/storage ceiling.",
    "To send: check ‘Yes, sign and send this transaction’, then choose Accept. Leaving it unchecked sends nothing.",
    "Technical details:",
    `Realm: ${JSON.stringify(call.pkgpath)}`,
    `Function: ${JSON.stringify(call.func)}`,
    `Arguments (in order): ${JSON.stringify(call.args)}`,
    `Gas limit: ${limits.gasWanted}`
  ].join("\n");
}
