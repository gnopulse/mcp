/**
 * Builds the McpServer with every tool registered, shared by the stdio and HTTP
 * transports. Dependencies in SharedDeps are created once; the API client is
 * created per server because it carries the caller's API key.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { ApiClient } from "./api.js";
import { VERSION } from "./version.js";
import type { RpcClient } from "./rpc.js";
import type { Gnotx } from "./gnotx.js";
import type { PolicyEngine, Signer } from "./signer/types.js";
import type { ApprovalStore } from "./signer/approvals.js";
import { Meter, metered } from "./meter.js";
import { registerReadTools } from "./tools/read.js";
import { registerV2Tools } from "./tools/v2.js";
import { registerChainTools } from "./tools/chain.js";
import { registerTokenTools } from "./tools/tokens.js";
import { registerExecutionTools } from "./tools/execution.js";

export interface SharedDeps {
  rpc: RpcClient;
  gnotx: Gnotx;
  policy: PolicyEngine;
  /** null when execution is disabled (simulate only). */
  signer: Signer | null;
  approvals: ApprovalStore;
}

export function buildMcpServer(cfg: Config, deps: SharedDeps): McpServer {
  const api = new ApiClient(cfg);
  const server = new McpServer({ name: "gnopulse", version: VERSION });

  // REST-backed tools are metered by the API; chain and signer tools are metered here.
  const meteredServer = metered(server, new Meter(cfg));

  registerReadTools(server, api);
  registerV2Tools(server, api);
  registerChainTools(meteredServer, deps.rpc);
  registerTokenTools(meteredServer, deps.rpc, cfg.grc20Registry);
  registerExecutionTools(meteredServer, {
    gnotx: deps.gnotx,
    rpc: deps.rpc,
    policy: deps.policy,
    signer: deps.signer,
    approvals: deps.approvals,
    chainId: cfg.chainId,
  });

  return server;
}
