/**
 * Configurable spending policy: realm and function allow/deny lists, a per-transaction ugnot
 * cap, an optional expiry, and a fees-only mode. Permissive by default, which suits the
 * human-approval signer; autonomous signers should be configured restrictively.
 *
 * Environment (all optional):
 *   GNOPULSE_POLICY_DEFAULT=allow|deny     default allow
 *   GNOPULSE_POLICY_ALLOW_REALMS=csv       if set, only these pkgpaths pass
 *   GNOPULSE_POLICY_DENY_REALMS=csv
 *   GNOPULSE_POLICY_ALLOW_FUNCS=csv
 *   GNOPULSE_POLICY_DENY_FUNCS=csv
 *   GNOPULSE_POLICY_MAX_SEND_UGNOT=int     per-tx cap on NATIVE ugnot; unparseable sends denied
 *   GNOPULSE_POLICY_EXPIRES_AT=unix-secs   absolute expiry; wins over EXPIRES_IN
 *   GNOPULSE_POLICY_EXPIRES_IN=secs        expiry relative to startup
 *   GNOPULSE_POLICY_FEES_ONLY=1            deny any non-zero NATIVE send. Not a value cap: a
 *                                          GRC20 transfer is a call with an empty send.
 *
 * Malformed numeric values throw a PolicyConfigError naming the variable.
 */
import type { Intent, PolicyDecision, PolicyEngine } from "./types.js";

export interface PolicyConfig {
  defaultAllow: boolean;
  allowRealms: string[];
  denyRealms: string[];
  allowFuncs: string[];
  denyFuncs: string[];
  maxSendUgnot?: bigint;
  /** Unix seconds after which every intent is denied. Undefined means no expiry. */
  expiresAt?: number;
  /** Realm calls are allowed but the send amount must be zero. */
  feesOnly?: boolean;
}

/** Parse a send string like "1000000ugnot". Empty means 0; anything other than pure ugnot is null. */
export function parseUgnot(send: string | undefined): bigint | null {
  if (!send?.trim()) return 0n;
  const m = send.trim().match(/^(\d+)ugnot$/);
  return m ? BigInt(m[1]) : null;
}

function realmOf(intent: Intent): string | undefined {
  return intent.pkgpath ?? intent.approve?.token;
}

function funcOf(intent: Intent): string | undefined {
  return intent.func ?? (intent.kind === "approve" ? "Approve" : undefined);
}

const deny = (reason: string): PolicyDecision => ({ allow: false, reason });

export class ConfigurablePolicy implements PolicyEngine {
  /** `now` returns unix seconds; injectable for tests. */
  constructor(
    private readonly cfg: PolicyConfig,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {}

  /**
   * True if the policy bounds WHAT may be called: an allowlist, or default-deny. Autonomous
   * signers require this.
   *
   * `maxSendUgnot` and `feesOnly` deliberately do not count. Both inspect `intent.send`, which
   * is native ugnot, so neither bounds a GRC20 transfer: that is an ordinary realm call with an
   * empty send, and it passes both. A policy of `feesOnly` alone would otherwise satisfy this
   * gate while allowing an agent to move every token the wallet holds.
   *
   * Deny lists and expiry alone do not count either.
   */
  get restrictive(): boolean {
    const c = this.cfg;
    return c.allowRealms.length > 0 || c.allowFuncs.length > 0 || !c.defaultAllow;
  }

  check(intent: Intent): PolicyDecision {
    const c = this.cfg;
    const realm = realmOf(intent);
    const func = funcOf(intent);

    if (c.expiresAt !== undefined && this.now() > c.expiresAt) {
      return deny("policy expired (session grant ended)");
    }
    if (c.feesOnly) {
      const amount = parseUgnot(intent.send);
      if (amount === null || amount > 0n) {
        return deny(`fees-only policy: value transfers not allowed (send="${intent.send ?? ""}")`);
      }
    }

    if (realm && c.denyRealms.includes(realm)) return deny(`realm ${realm} is denylisted`);
    if (func && c.denyFuncs.includes(func)) return deny(`function ${func} is denylisted`);
    if (c.allowRealms.length && (!realm || !c.allowRealms.includes(realm))) {
      return deny(`realm ${realm ?? "?"} not in the allowlist`);
    }
    if (c.allowFuncs.length && (!func || !c.allowFuncs.includes(func))) {
      return deny(`function ${func ?? "?"} not in the allowlist`);
    }

    if (c.maxSendUgnot !== undefined) {
      const amount = parseUgnot(intent.send);
      if (amount === null) return deny(`cannot verify send "${intent.send}" against the ugnot cap`);
      if (amount > c.maxSendUgnot) {
        return deny(`send ${amount}ugnot exceeds per-tx cap ${c.maxSendUgnot}ugnot`);
      }
    }

    // An intent that passed a configured allowlist is allowed even under default-deny;
    // the default applies only when no allowlist is configured.
    const hasAllowlist = c.allowRealms.length > 0 || c.allowFuncs.length > 0;
    if (hasAllowlist || c.defaultAllow) return { allow: true };
    return deny("default-deny policy and no allow rule configured");
  }
}

/** A policy environment variable has an invalid value. */
export class PolicyConfigError extends Error {
  constructor(name: string, value: string, expected: string) {
    super(`${name}="${value}" is invalid: expected ${expected}`);
    this.name = "PolicyConfigError";
  }
}

type Env = Record<string, string | undefined>;

function csv(env: Env, name: string): string[] {
  const value = env[name];
  return value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/** The variable as a non-negative integer string, undefined when unset or empty. */
function uintVar(env: Env, name: string, expected: string): string | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) throw new PolicyConfigError(name, value, expected);
  return value;
}

function envExpiry(env: Env): number | undefined {
  const at = uintVar(env, "GNOPULSE_POLICY_EXPIRES_AT", "a unix time in seconds");
  const inSecs = uintVar(env, "GNOPULSE_POLICY_EXPIRES_IN", "a number of seconds");
  if (at !== undefined) return Number(at);
  if (inSecs !== undefined) return Math.floor(Date.now() / 1000) + Number(inSecs);
  return undefined;
}

/** Build the policy from the environment. Throws PolicyConfigError on a malformed value. */
export function loadPolicy(env: Env = process.env): ConfigurablePolicy {
  const maxSend = uintVar(env, "GNOPULSE_POLICY_MAX_SEND_UGNOT", "an integer amount of ugnot");
  return new ConfigurablePolicy({
    defaultAllow: (env.GNOPULSE_POLICY_DEFAULT || "allow") !== "deny",
    allowRealms: csv(env, "GNOPULSE_POLICY_ALLOW_REALMS"),
    denyRealms: csv(env, "GNOPULSE_POLICY_DENY_REALMS"),
    allowFuncs: csv(env, "GNOPULSE_POLICY_ALLOW_FUNCS"),
    denyFuncs: csv(env, "GNOPULSE_POLICY_DENY_FUNCS"),
    maxSendUgnot: maxSend !== undefined ? BigInt(maxSend) : undefined,
    expiresAt: envExpiry(env),
    feesOnly: env.GNOPULSE_POLICY_FEES_ONLY === "1",
  });
}
