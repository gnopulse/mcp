/**
 * Pending approvals for the two-step human-approval flow.
 *
 * gno_call registers an intent and returns a single-use token; gno_confirm redeems it to
 * broadcast. Tokens expire so a stale proposal cannot be executed later. State is in-memory
 * and per-process.
 */
import { randomUUID } from "node:crypto";
import type { Intent } from "./types.js";

export interface Pending {
  token: string;
  intent: Intent;
  preview: unknown;
  expiresAt: number;
}

export class ApprovalStore {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly ttlMs = 5 * 60 * 1000) {}

  create(intent: Intent, preview: unknown): Pending {
    const entry: Pending = { token: randomUUID(), intent, preview, expiresAt: Date.now() + this.ttlMs };
    this.pending.set(entry.token, entry);
    return entry;
  }

  /** Redeem a token. Single-use; returns undefined if the token is unknown or expired. */
  take(token: string): Pending | undefined {
    const entry = this.pending.get(token);
    if (!entry) return undefined;
    this.pending.delete(token);
    return Date.now() > entry.expiresAt ? undefined : entry;
  }

  get ttlSeconds(): number {
    return Math.round(this.ttlMs / 1000);
  }
}
