/** Shared helpers for MCP tool handlers. */
import { isAbsent, type Absent } from "../rpc.js";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** Wrap a value as a text tool result; non-strings are pretty-printed JSON. */
export function ok(value: unknown): ToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const ENDPOINT = /\b(?:https?|wss?):\/\/[^\s"')]+/gi;

/**
 * The part of an error a caller may see.
 *
 * Upstream failures carry the endpoint they came from, and an upstream body slice with them.
 * Neither is the caller's to read: it names hosts they cannot reach and were not told about.
 * The kind of failure is useful, so keep that and drop the rest.
 */
export function safeErrorMessage(e: unknown): string {
  const kind = e instanceof Error && e.name && e.name !== "Error" ? `${e.name}: ` : "";
  const text = errorMessage(e).replace(ENDPOINT, "<endpoint>");
  return kind + (text.length > 300 ? `${text.slice(0, 300)}…` : text);
}

/**
 * Run a handler, converting thrown errors into an error result.
 *
 * The full error goes to stderr, where the operator can see it; the caller gets the redacted
 * form.
 */
export async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    process.stderr.write(`tool error: ${errorMessage(e)}\n`);
    return fail(safeErrorMessage(e));
  }
}

/** Trim a realm, token, pool, or address for use as an API path segment. Slashes are kept. */
export const pathSegment = (s: string): string => s.trim();

export function absentToNull(v: string | Absent): string | null {
  return isAbsent(v) ? null : v;
}

/** The chain's reason for an absent result (e.g. "package not found"), if any. */
export function absentReason(v: string | Absent): string | undefined {
  return isAbsent(v) ? v.reason : undefined;
}

export type GnoScalar = string | number | boolean | null;

/**
 * Parse gno's qeval scalar format `(value type)`:
 *   `("wugnot" string)` -> "wugnot", `(3000000 int64)` -> 3000000, `(true bool)` -> true.
 * Integers outside the safe range are returned as strings. Unrecognized shapes are returned
 * verbatim.
 */
export function parseGnoScalar(raw: string | null): GnoScalar {
  if (raw == null) return null;
  const s = raw.trim();
  if (!s) return null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^\("([\s\S]*)"\s+string\)$/))) return m[1];
  if ((m = s.match(/^\((-?\d+)\s+u?int\d*\)$/))) {
    const n = Number(m[1]);
    return Number.isSafeInteger(n) ? n : m[1];
  }
  if ((m = s.match(/^\((true|false)\s+bool\)$/))) return m[1] === "true";
  return s;
}

export type Coin = { denom: string; amount: string };

export type AminoAccount = {
  address?: string;
  balances: Coin[];
  account_number: string | null;
  sequence: string | null;
  public_key: unknown;
};

/** Parse a coins string like "12345ugnot,678foo". Malformed entries are skipped. */
function parseCoins(coins: string): Coin[] {
  return coins
    .split(",")
    .map((c) => c.trim().match(/^(\d+)(.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ denom: m[2], amount: m[1] }));
}

/**
 * Parse the decoded amino account JSON from auth/accounts. Returns null if the input is not
 * a JSON object (the node returns "null" for an address with no account).
 */
export function parseAminoAccount(raw: string): AminoAccount | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object") return null;
  const wrapped = obj as { BaseAccount?: Record<string, unknown> } & Record<string, unknown>;
  const ba = wrapped.BaseAccount ?? wrapped;
  return {
    address: typeof ba.address === "string" ? ba.address : undefined,
    balances: typeof ba.coins === "string" && ba.coins ? parseCoins(ba.coins) : [],
    account_number: (ba.account_number as string | undefined) ?? null,
    sequence: (ba.sequence as string | undefined) ?? null,
    public_key: ba.public_key ?? null,
  };
}

/** The ugnot amount in an account's balances, "0" if none. */
export function ugnotBalance(account: AminoAccount | null): string {
  return account?.balances.find((b) => b.denom === "ugnot")?.amount ?? "0";
}
