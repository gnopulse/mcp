/** Signed approvals supplied by a trusted host, outside model-controlled tool arguments. */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pending } from "./approvals.js";

export const CLIENT_APPROVAL_META = "io.gnopulse/approval";

export interface ApprovalChallenge {
  protocol: "gnopulse-transaction-approval-v1";
  token: string;
  agent: string;
  chain: string;
  wallet: string;
  expiresAt: number;
  intent: Pending["intent"];
  previewDigest: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}

export function approvalChallenge(
  pending: Pending,
  agent: string,
  chain: string,
  wallet: string
): ApprovalChallenge {
  return {
    protocol: "gnopulse-transaction-approval-v1",
    token: pending.token,
    agent,
    chain,
    wallet,
    expiresAt: pending.expiresAt,
    intent: structuredClone(pending.intent),
    previewDigest: createHash("sha256").update(canonical(pending.preview)).digest("hex")
  };
}

/** Run only in the trusted host after human consent, never as a model tool. */
export function signClientApproval(
  challenge: ApprovalChallenge,
  privateKeyPem: string,
  decision: "approve" | "deny"
) {
  if (
    challenge.protocol !== "gnopulse-transaction-approval-v1" ||
    !Number.isSafeInteger(challenge.expiresAt) ||
    Date.now() >= challenge.expiresAt
  )
    throw new Error("Invalid or expired transaction approval challenge.");
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Client approval requires an Ed25519 authorization key.");
  const payload = { challenge, decision };
  return { ...payload, signature: sign(null, Buffer.from(canonical(payload)), key).toString("base64") };
}

export function verifyClientApproval(
  receipt: unknown,
  expected: ApprovalChallenge,
  publicKeyPem: string
): boolean {
  try {
    if (Date.now() >= expected.expiresAt || !receipt || typeof receipt !== "object") return false;
    const r = receipt as { challenge?: unknown; decision?: unknown; signature?: unknown };
    if (
      r.decision !== "approve" ||
      typeof r.signature !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/.test(r.signature)
    )
      return false;
    if (canonical(r.challenge) !== canonical(expected)) return false;
    return verify(
      null,
      Buffer.from(canonical({ challenge: expected, decision: "approve" })),
      publicKeyPem,
      Buffer.from(r.signature, "base64")
    );
  } catch {
    return false;
  }
}

export function loadApprovalPublicKey(file?: string): string | undefined {
  if (!file) return undefined;
  const pem = readFileSync(file, "utf8");
  if (pem.length > 16384) throw new Error("Client approval public key file is too large.");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Client approval requires an Ed25519 public key.");
  return key.export({ type: "spki", format: "pem" }).toString();
}
