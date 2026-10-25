#!/usr/bin/env node
/**
 * GnoPulse MCP server entry point. Serves the same tools over stdio (default)
 * or Streamable HTTP (GNOPULSE_MCP_TRANSPORT=http). Configuration is read from
 * the environment; see config.ts and signer/policy.ts.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { RpcClient } from "./rpc.js";
import { Gnotx } from "./gnotx.js";
import { DENY_ALL, type PolicyEngine, type Signer } from "./signer/types.js";
import { UserApprovalSigner } from "./signer/userApproval.js";
import { MicroserviceSigner } from "./signer/microservice.js";
import { TeeSigner } from "./signer/tee.js";
import { ConfigurablePolicy, loadPolicy, PolicyConfigError } from "./signer/policy.js";
import { ApprovalStore } from "./signer/approvals.js";
import { buildMcpServer, type SharedDeps } from "./server.js";
import { startHttpServer } from "./http.js";
import { VERSION } from "./version.js";

function die(msg: string): never {
  process.stderr.write(`fatal: ${msg}\n`);
  process.exit(1);
}

/**
 * Select the signer from GNOPULSE_SIGNER:
 * - `none` (default): simulate only, execution disabled
 * - `user-approval`: every write needs an explicit confirm
 * - `microservice`: autonomous, bounded by policy
 * - `tee`: autonomous, signing service backed by an external signer (local mnemonic or Turnkey)
 */
function selectSigner(gnotx: Gnotx): {
  signer: Signer | null;
  policy: PolicyEngine;
} {
  const kind = (process.env.GNOPULSE_SIGNER || "none").trim();
  switch (kind) {
    case "none":
      return { signer: null, policy: DENY_ALL };
    case "user-approval":
      return { signer: new UserApprovalSigner(gnotx), policy: policyFromEnv() };
    case "microservice":
      return { signer: new MicroserviceSigner(gnotx), policy: policyFromEnv() };
    case "tee":
      return { signer: new TeeSigner(gnotx), policy: policyFromEnv() };
    default:
      return die(`GNOPULSE_SIGNER=${kind}: unknown (none|user-approval|microservice|tee).`);
  }
}

function policyFromEnv(): ConfigurablePolicy {
  try {
    return loadPolicy();
  } catch (e) {
    if (e instanceof PolicyConfigError) die(e.message);
    throw e;
  }
}

/** Refuse configurations that would run an unbounded or shared key. */
function assertSafeSigner(signer: Signer | null, policy: PolicyEngine, transport: string): void {
  if (!signer) return;
  if (!process.env.GNOPULSE_AGENT_ID || !process.env.GNOPULSE_AGENT_ADDRESS)
    die(
      "Signing requires GNOPULSE_AGENT_ID and GNOPULSE_AGENT_ADDRESS, with an explicitly enabled owner-controlled service."
    );
  // Every HTTP client would share one signer, so HTTP stays read/simulate only.
  if (transport === "http") {
    die(`GNOPULSE_SIGNER=${signer.kind} is not allowed over HTTP; the HTTP transport is read/simulate only.`);
  }
  if (!signer.requiresApproval && !(policy instanceof ConfigurablePolicy && policy.restrictive)) {
    die(
      `GNOPULSE_SIGNER=${signer.kind} is autonomous (no human approval) but the policy does not ` +
        "bound what it may call. Set GNOPULSE_POLICY_ALLOW_REALMS, _ALLOW_FUNCS, or _DEFAULT=deny. " +
        "_MAX_SEND_UGNOT and _FEES_ONLY cap native ugnot only and do not bound a GRC20 transfer, " +
        "so neither is enough on its own."
    );
  }
  if (!signer.requiresApproval && !(policy instanceof ConfigurablePolicy && policy.boundedAutonomy))
    die(
      "Autonomous signing requires realm and function allowlists, explicit native-send, fee and gas limits, and a future expiry. Set GNOPULSE_POLICY_ALLOW_REALMS, _ALLOW_FUNCS, _MAX_SEND_UGNOT, _MAX_FEE_UGNOT, _MAX_GAS and _EXPIRES_AT or _EXPIRES_IN."
    );
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const gnotx = new Gnotx(cfg);
  const { signer, policy } = selectSigner(gnotx);
  assertSafeSigner(signer, policy, cfg.transport);

  const deps: SharedDeps = {
    rpc: new RpcClient(cfg),
    gnotx,
    policy,
    signer,
    approvals: new ApprovalStore(),
    simulationAvailable:
      cfg.simulationConfigured &&
      (await gnotx.verifiedHealth().then(
        (h) =>
          h.ok === true &&
          h.unsigned_simulation === true &&
          h.chainid === cfg.chainId &&
          (cfg.transport !== "http" || (h.keyless === true && h.execution_enabled === false)),
        () => false
      ))
  };

  if (cfg.transport === "http") {
    await startHttpServer(cfg, deps);
    return;
  }

  await buildMcpServer(cfg, deps).connect(new StdioServerTransport());
  process.stderr.write(
    `gnopulse-mcp v${VERSION} ready (stdio), api=${cfg.apiBase} rpc=${cfg.rpcUrls.length} endpoint(s) ` +
      `chain=${cfg.chainId} signer=${signer ? signer.kind : "none (execution disabled)"}\n`
  );
}

main().catch((e: unknown) => {
  die(e instanceof Error ? e.stack || e.message : String(e));
});
