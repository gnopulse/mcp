import { approvalChallenge, CLIENT_APPROVAL_META, verifyClientApproval } from "../signer/clientApproval.js";
/**
 * Execution tools. Every write follows the same flow:
 *   1. build an Intent
 *   2. simulate it (gas and result preview)
 *   3. check it against the PolicyEngine
 *   4. then, depending on the signer:
 *        approval required -> store a pending approval and return a token for gno_confirm
 *        autonomous        -> broadcast immediately
 *        none              -> return the preview only
 *
 * Keys live in the separate signing service and never reach this process.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SignerIdentityError, type Gnotx, type GnotxEnvelope } from "../gnotx.js";
import type { RpcClient } from "../rpc.js";
import type { Intent, PolicyEngine, Signer } from "../signer/types.js";
import type { ApprovalStore } from "../signer/approvals.js";
import { ConfigurablePolicy } from "../signer/policy.js";
import { approvalMessage, previewLimits } from "../signer/approvalDisplay.js";
import { callForIntent } from "../signer/call.js";
import {
  absentToNull,
  errorMessage,
  guard,
  ok,
  parseAminoAccount,
  ugnotBalance,
  type AminoAccount,
  type ToolResult
} from "./util.js";

const MAINNET_CHAIN_ID = "gnoland-1";
const TESTNET_FAUCET = "https://faucet.gno.land";

/** Testnets have a public faucet; mainnet GNOT has to come from the user. */
function faucetFor(chainId: string): string | null {
  return chainId !== MAINNET_CHAIN_ID ? TESTNET_FAUCET : null;
}

function fundingHint(chainId: string): string {
  const faucet = faucetFor(chainId);
  return faucet ? ` (faucet: ${faucet})` : "";
}
const EXEC_GUIDE = "https://gnopulse.xyz/quickstart";
const GAS_ESTIMATE = "0.2 to 0.7 GNOT";
const CLA_REALM = "gno.land/r/sys/cla";

const ENABLE_HINT =
  "Execution is disabled: this server is read/simulate-only and holds no keys. To enable on-chain " +
  "execution, the user runs the GnoPulse MCP locally with GNOPULSE_SIGNER=user-approval and a local " +
  `gnotx signing service (see ${EXEC_GUIDE}). The key stays on the user's machine.`;

export interface ExecutionDeps {
  gnotx: Gnotx;
  rpc: RpcClient;
  policy: PolicyEngine;
  /** Null when execution is disabled (simulate-only). */
  signer: Signer | null;
  approvals: ApprovalStore;
  /** Configured chain id, used when the signing service does not report one. */
  chainId: string;
  agentAddress?: string;
  agentId?: string;
  approvalPublicKey?: string;
  /** HTTP exposes reads and simulation, never execution or confirmation tools. */
  readOnly?: boolean;
  simulationAvailable?: boolean;
}

export function registerExecutionTools(server: McpServer, deps: ExecutionDeps): void {
  const { gnotx, rpc, policy, signer, approvals } = deps;

  /** The signing service's address and chain, plus that address's on-chain account if it has one. */
  async function agentAccount(): Promise<{
    address: string | null;
    chainId: string;
    account: AminoAccount | null;
  }> {
    const address = deps.agentAddress ?? null;
    const chainId = deps.chainId;
    try {
      const health = await gnotx.verifiedHealth();
      if (!health.ok || !address) return { address, chainId, account: null };
    } catch (e) {
      if (e instanceof SignerIdentityError) throw e;
      return { address, chainId, account: null };
    }
    const raw = await rpc.authAccount(address).then(absentToNull, () => null);
    return {
      address,
      chainId,
      account: raw !== null ? parseAminoAccount(raw) : null
    };
  }

  server.registerTool(
    "gno_agent_status",
    {
      title: "Agent status (who am I / can I act)",
      description:
        "The agent's own on-chain identity: the address this MCP signs with (use it as your caller or " +
        "recipient), its ugnot balance and sequence, the chain, whether execution is enabled, and the " +
        "active policy bounds. Call this first, before acting, to learn your address and whether you can pay gas.",
      inputSchema: {}
    },
    () =>
      guard(async () => {
        const { address, chainId, account } = await agentAccount();
        const balanceUgnot = account ? ugnotBalance(account) : null;
        const funded = balanceUgnot !== null && balanceUgnot !== "0";

        let nextStep: string;
        if (signer === null) {
          nextStep = ENABLE_HINT;
        } else if (balanceUgnot === null) {
          nextStep =
            "Wallet balance is unavailable. Check the configured service and RPC before funding or acting.";
        } else if (!funded) {
          nextStep =
            `Wallet ${address ?? "?"} has no GNOT for gas. Ask the user to fund it${fundingHint(chainId)}; ` +
            `each action typically costs ${GAS_ESTIMATE}.`;
        } else {
          nextStep =
            "Ready. Every action is simulated and policy-checked before signing. Use gno_simulate to " +
            "preview and gno_call, gno_swap, or gno_approve to act within the policy above.";
        }

        return ok({
          address,
          chain: chainId,
          balance_ugnot: balanceUgnot,
          account_number: account?.account_number ?? null,
          sequence: account?.sequence ?? null,
          funded,
          execution_enabled: signer !== null,
          signing_mode: !signer ? "disabled" : signer.requiresApproval ? "interactive" : "autonomous",
          approval_methods: signer?.requiresApproval
            ? ["mcp_elicitation", ...(deps.approvalPublicKey ? ["signed_client_approval"] : [])]
            : [],
          agent_id: process.env.GNOPULSE_AGENT_ID || null,
          simulation_available: deps.simulationAvailable === true,
          faucet: faucetFor(chainId),
          guide: EXEC_GUIDE,
          next_steps: [nextStep],
          policy: policy instanceof ConfigurablePolicy ? policy.describe() : { default: "deny" }
        });
      })
  );

  if (deps.simulationAvailable)
    server.registerTool(
      "gno_simulate",
      {
        title: "Simulate call",
        description:
          "Simulate a realm function call without broadcasting. Returns gas used, the return value, and " +
          "whether it would succeed. No transaction is signed or broadcast. Later chain state can change the result.",
        inputSchema: {
          pkgpath: z.string().describe("target realm pkgpath"),
          func: z.string().describe("exported function name"),
          args: z.array(z.string()).optional().describe("positional args, in order"),
          send: z.string().optional().describe("coins to send, e.g. 1000000ugnot"),
          caller: z
            .string()
            .optional()
            .describe("caller address (required on hosted HTTP; local defaults to the agent wallet)"),
          publicKey: z
            .string()
            .regex(/^(02|03)[0-9a-fA-F]{64}$/)
            .optional()
            .describe("compressed public key hex, needed before the caller publishes its first transaction")
        }
      },
      ({ pkgpath, func, args, send, caller, publicKey }) =>
        guard(async () => {
          if (deps.readOnly && !caller)
            return {
              ...ok({
                status: "invalid_param",
                reason: "caller is required for hosted simulation"
              }),
              isError: true
            };
          try {
            const preview = await gnotx.simulateCall(pkgpath, func, args, send, caller, publicKey);
            return {
              ...ok(preview),
              ...(preview.ok !== true ? { isError: true } : {})
            };
          } catch (e) {
            return {
              ...ok({ status: "simulate_failed", reason: errorMessage(e) }),
              isError: true
            };
          }
        })
    );

  if (deps.readOnly) return;

  async function propose(intent: Intent): Promise<ToolResult> {
    if (!signer) return ok({ status: "execution_disabled", note: ENABLE_HINT });
    const call = callForIntent(intent);
    Object.assign(intent, call);
    const initialDecision = await policy.check(intent);
    if (!initialDecision.allow) return ok({ status: "policy_denied", reason: initialDecision.reason });
    // An unfunded address has no on-chain account, so simulation would fail with an opaque
    // error. Report the address and faucet instead.
    if (signer) {
      const { address, chainId, account } = await agentAccount();
      if (address && account && ugnotBalance(account) === "0") {
        return ok({
          status: "needs_funding",
          intent: intent.summary,
          address,
          faucet: faucetFor(chainId),
          message:
            `The agent wallet ${address} needs gas before it can act. Offer the user to send a small ` +
            `amount of GNOT to that address${fundingHint(chainId)}; ${GAS_ESTIMATE} is typically enough.`
        });
      }
    }

    let preview: GnotxEnvelope;
    try {
      preview = await gnotx.simulateCall(call.pkgpath, call.func, call.args, call.send);
    } catch (e) {
      return ok({
        status: "simulate_failed",
        reason: errorMessage(e),
        intent: intent.summary,
        note: signer
          ? "Simulation failed, so the action was not checked against policy or sent to a signer."
          : "Simulation failed. Simulation requires a reachable signing service; set GNOPULSE_SIGNER " +
            "once one is available."
      });
    }

    if (preview.ok !== true)
      return ok({
        status: "simulate_failed",
        reason: preview.log || "Simulation did not succeed",
        simulate: preview
      });
    const limits = previewLimits(preview);
    if (!limits)
      return ok({
        status: "simulate_failed",
        reason:
          "Simulation did not supply complete, consistent gas and storage cost bounds. Update the simulation backend."
      });
    intent.executionLimits = limits;
    const decision = await policy.check(intent);
    if (!decision.allow) {
      return ok({
        status: "policy_denied",
        reason: decision.reason,
        intent: intent.summary,
        simulate: preview
      });
    }
    if (!signer) {
      return ok({
        status: "execution_disabled",
        note: ENABLE_HINT,
        intent: intent.summary,
        simulate: preview
      });
    }
    if (signer.requiresApproval) {
      const pending = approvals.create(intent, preview);
      return ok({
        status: "awaiting_approval",
        intent: intent.summary,
        simulate: preview,
        approval_token: pending.token,
        ...(deps.approvalPublicKey
          ? {
              approval_challenge: approvalChallenge(
                pending,
                deps.agentId || "",
                deps.chainId,
                deps.agentAddress || ""
              )
            }
          : {}),
        expires_in_seconds: approvals.ttlSeconds,
        next: `Review the simulation result. To broadcast, call gno_confirm with token="${pending.token}".`
      });
    }
    const result = await signer.execute(intent);
    return ok({
      status: "executed",
      intent: intent.summary,
      simulate: preview,
      result
    });
  }

  server.registerTool(
    "gno_call",
    {
      title: "Call realm (write)",
      description:
        "Make a state-changing realm call (mint, register, any write) from the agent's own wallet. " +
        "Always simulates and checks policy first. Then an autonomous signer broadcasts immediately, a " +
        "human-approval signer returns an approval_token for gno_confirm, and simulate-only mode returns " +
        "the preview. If the wallet has no gas, returns status:needs_funding with the address and faucet; " +
        "offer that to the user instead of reporting an error. Use this when a request requires an on-chain action.",
      inputSchema: {
        pkgpath: z.string(),
        func: z.string(),
        args: z.array(z.string()).optional(),
        send: z.string().optional()
      }
    },
    ({ pkgpath, func, args, send }) =>
      guard(async () => {
        const intent: Intent = {
          kind: "call",
          pkgpath,
          func,
          args,
          send,
          summary: `call ${pkgpath}.${func}(${(args ?? []).join(", ")})${send ? ` send ${send}` : ""}`
        };
        return propose(intent);
      })
  );

  server.registerTool(
    "gno_approve",
    {
      title: "Approve GRC20 (write)",
      description:
        "Approve a GRC20 allowance from the agent's own wallet (required before a swap). Simulates and " +
        "checks policy, then broadcasts (autonomous signer), returns an approval_token for gno_confirm " +
        "(human-approval signer), or returns the preview (simulate-only). If unfunded, returns " +
        "status:needs_funding with the address and faucet.",
      inputSchema: {
        token: z.string().describe("GRC20 token pkgpath"),
        spender: z.string().describe("address allowed to spend (router/pool)"),
        amount: z.string().describe("allowance, raw units")
      }
    },
    ({ token, spender, amount }) =>
      guard(async () => {
        const intent: Intent = {
          kind: "approve",
          pkgpath: token,
          approve: { token, spender, amount },
          summary: `approve ${token} spender=${spender} amount=${amount}`
        };
        return propose(intent);
      })
  );

  server.registerTool(
    "gno_swap",
    {
      title: "Swap (write)",
      description:
        "Swap on GnoSwap (router.ExactInSwapRoute) from the agent's own wallet. Simulates and checks " +
        "policy, then broadcasts (autonomous signer), returns an approval_token for gno_confirm " +
        "(human-approval signer), or returns the preview (simulate-only). The input token must first be " +
        "approved to the router (gno_approve). If unfunded, returns status:needs_funding with the address and faucet.",
      inputSchema: {
        tokenIn: z.string().describe("input token pkgpath"),
        tokenOut: z.string().describe("output token pkgpath"),
        amountIn: z.string().describe("exact input amount, raw units"),
        minOut: z.string().describe("minimum output (slippage floor), raw units"),
        fee: z.string().optional().describe("fee tier 100/500/3000/10000 (default 500)"),
        deadlineSecs: z.number().int().optional().describe("seconds until expiry (default 120)")
      }
    },
    ({ tokenIn, tokenOut, amountIn, minOut, fee, deadlineSecs }) =>
      guard(async () => {
        const swap = {
          tokenIn,
          tokenOut,
          amountIn,
          minOut,
          fee,
          deadlineSecs,
          deadline: Math.floor(Date.now() / 1000) + (deadlineSecs ?? 120)
        };
        const intent: Intent = {
          kind: "swap",
          swap,
          summary: `swap ${amountIn} ${tokenIn} → ${tokenOut} (minOut ${minOut}, fee ${fee ?? "500"})`
        };
        return propose(intent);
      })
  );

  server.registerTool(
    "gno_deploy",
    {
      title: "Deploy realm, readiness + recipe",
      description:
        "Check whether an address can deploy a package on the current chain and return the deploy " +
        "command. CLA enforcement varies by chain and over time, so the CLA signature is checked live " +
        "on every call. The deploy itself runs via `gnotx addpkg`.",
      inputSchema: {
        deployer: z.string().describe("g1… address that will deploy"),
        pkgpath: z
          .string()
          .optional()
          .describe("intended path; must be address-namespaced, e.g. gno.land/r/<deployer>/mypkg")
      }
    },
    ({ deployer, pkgpath }) =>
      guard(async () => {
        const signed = absentToNull(
          await rpc.qeval(`${CLA_REALM}.HasValidSignature(${JSON.stringify(deployer)})`)
        );
        const hasSigned = signed?.includes("true") ?? false;
        if (!hasSigned) {
          return ok({
            deployer,
            cla_signed: false,
            status: "cla_required",
            next: [
              `Read the current CLA hash: gno_render ${CLA_REALM}`,
              `Sign it: gno_call ${CLA_REALM}.Sign(<hash>) → gno_confirm`,
              "Then re-run gno_deploy; it will report ready."
            ]
          });
        }
        return ok({
          deployer,
          cla_signed: true,
          status: "ready",
          deploy: {
            cmd: `gnotx addpkg -pkgpath ${pkgpath ?? `gno.land/r/${deployer}/<pkg>`} -pkgdir <dir> -broadcast`,
            notes:
              "The path must be address-namespaced (gno.land/r/<deployer>/<pkg>). A gnomod.toml is added " +
              "automatically, files are sorted, and the package name comes from the `package` clause."
          }
        });
      })
  );

  server.registerTool(
    "gno_confirm",
    {
      title: "Confirm & broadcast",
      description:
        "Request client-side human consent for a proposed action. A proposal token is not approval. " +
        "Requires MCP elicitation or a signed approval from a configured trusted client; unsupported clients never execute.",
      inputSchema: {
        token: z.string().describe("approval_token returned by a propose call")
      }
    },
    ({ token }, extra) =>
      guard(async () => {
        if (!signer) return ok({ status: "execution_disabled", note: ENABLE_HINT });
        const pending = approvals.take(token);
        if (!pending) {
          return ok({
            status: "invalid_token",
            note: "Unknown or expired approval token; propose the action again."
          });
        }
        // Policy may have changed since the action was proposed.
        const decision = await policy.check(pending.intent);
        if (!decision.allow) {
          return ok({
            status: "policy_denied",
            reason: decision.reason,
            intent: pending.intent.summary
          });
        }
        const receipt = extra._meta?.[CLIENT_APPROVAL_META];
        const identity = await agentAccount();
        if (receipt !== undefined) {
          if (
            !deps.approvalPublicKey ||
            !identity.address ||
            !verifyClientApproval(
              receipt,
              approvalChallenge(pending, deps.agentId || "", identity.chainId, identity.address),
              deps.approvalPublicKey
            )
          )
            return ok({
              status: "approval_denied",
              reason: "Client authorization is invalid, expired, or does not match this transaction."
            });
        } else {
          const elicitation = server.server.getClientCapabilities()?.elicitation;
          if (!elicitation || (!("form" in elicitation) && Object.keys(elicitation).length !== 0)) {
            return ok({
              status: "approval_unavailable",
              reason:
                "This client cannot collect independent human consent. Use MCP elicitation or a configured trusted client authorization adapter."
            });
          }
          let consent;
          try {
            consent = await server.server.elicitInput(
              {
                mode: "form",
                message: approvalMessage(
                  pending.intent,
                  pending.preview as GnotxEnvelope,
                  deps.agentId || "unknown",
                  identity.chainId,
                  identity.address || "unknown"
                ),
                requestedSchema: {
                  type: "object",
                  properties: {
                    approve: {
                      type: "boolean",
                      title: "Yes, sign and send this transaction",
                      description:
                        "Check this box, then choose Accept. Accept alone does not authorize a transaction.",
                      default: false
                    }
                  },
                  required: ["approve"]
                }
              },
              {
                signal: extra.signal,
                timeout: Math.max(1, pending.expiresAt - Date.now())
              }
            );
          } catch {
            return ok({
              status: extra.signal.aborted
                ? "approval_cancelled"
                : Date.now() >= pending.expiresAt
                  ? "approval_expired"
                  : "approval_failed",
              reason:
                "Client approval did not complete. Nothing was signed or broadcast. Check the client's approval interface before proposing again."
            });
          }
          if (consent.action !== "accept" || consent.content?.approve !== true)
            return ok({
              status: "approval_declined",
              reason:
                "Transaction not authorized. To authorize a new proposal, check the signing checkbox before choosing Accept."
            });
        }
        if (extra.signal.aborted) return ok({ status: "approval_cancelled" });
        if (Date.now() >= pending.expiresAt)
          return ok({
            status: "invalid_token",
            note: "Approval expired; propose again."
          });
        const current = await policy.check(pending.intent);
        if (!current.allow) return ok({ status: "policy_denied", reason: current.reason });
        if (extra.signal.aborted) return ok({ status: "approval_cancelled" });
        if (Date.now() >= pending.expiresAt) return ok({ status: "approval_expired" });
        const result = await signer.execute(pending.intent);
        return ok({
          status: "executed",
          intent: pending.intent.summary,
          result
        });
      })
  );
}
