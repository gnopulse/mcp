// Real SDK transport: expiry/cancellation never authorizes a late consent response.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer } from "../../dist/server.js";
import { loadConfig } from "../../dist/config.js";
import { ApprovalStore } from "../../dist/signer/approvals.js";
import { ConfigurablePolicy } from "../../dist/signer/policy.js";
import { check, run } from "./lib.mjs";

// Approval runs through the test client's form, never a real window on this machine.
process.env.GNOPULSE_APPROVAL_DIALOG = "off";
await run(async () => {
  for (const mode of ["expiry", "cancel", "policy"]) {
    const cancel = mode !== "expiry";
    let accepted = false,
      releasePolicy,
      held = false,
      enteredPolicy;
    const policyEntered = new Promise((r) => (enteredPolicy = r));
    let executions = 0,
      requested;
    const reached = new Promise((r) => (requested = r));
    const cfg = {
      ...loadConfig(),
      apiKey: undefined,
      chainId: "onyx-1",
      agentId: "fixture",
      agentAddress: "g1fixture",
      transport: "stdio"
    };
    const gnotx = {
      verifiedHealth: async () => ({ ok: true, chainid: cfg.chainId, caller: cfg.agentAddress }),
      simulateCall: async () => ({
        ok: true,
        gas_wanted: 1000,
        extra: {
          estimated_fee_ugnot: "1",
          estimated_storage_deposit_ugnot: "0",
          storage_deposit_limit_ugnot: "1",
          estimated_storage_refund_ugnot: "0",
          estimated_total_fee_ugnot: "2"
        }
      })
    };
    const signer = {
      kind: "user-approval",
      requiresApproval: true,
      execute: async () => {
        executions++;
        return { ok: true };
      }
    };
    const rpc = {
      authAccount: async () =>
        JSON.stringify({
          address: cfg.agentAddress,
          coins: "1000000ugnot",
          account_number: "1",
          sequence: "0"
        })
    };
    const policy = new ConfigurablePolicy({
      defaultAllow: true,
      allowRealms: [],
      denyRealms: [],
      allowFuncs: [],
      denyFuncs: []
    });
    const checkPolicy = policy.check.bind(policy);
    policy.check = async (intent) => {
      if (mode === "policy" && accepted && !held) {
        held = true;
        await new Promise((resolve) => {
          releasePolicy = resolve;
          enteredPolicy();
        });
      }
      return checkPolicy(intent);
    };
    const server = buildMcpServer(cfg, {
      gnotx,
      rpc,
      signer,
      policy,
      approvals: new ApprovalStore(cancel ? 1000 : 150),
      simulationAvailable: true
    });
    const [s, c] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "approval-timeout-fixture", version: "1" },
      { capabilities: { elicitation: { form: {} } } }
    );
    let respond;
    client.setRequestHandler(ElicitRequestSchema, () => {
      requested();
      if (mode === "policy") {
        accepted = true;
        return { action: "accept", content: { approve: true } };
      }
      return new Promise((r) => (respond = r));
    });
    await server.connect(s);
    await client.connect(c);
    try {
      const p = JSON.parse(
        (
          await client.callTool({
            name: "gno_call",
            arguments: { pkgpath: "gno.land/r/demo/x", func: "Ping" }
          })
        ).content[0].text
      );
      const controller = new AbortController();
      const outcome = client
        .callTool({ name: "gno_confirm", arguments: { token: p.approval_token } }, undefined, {
          signal: controller.signal
        })
        .then(
          (r) => ({ result: r }),
          (e) => ({ error: e })
        );
      await reached;
      if (mode === "policy") {
        await policyEntered;
        controller.abort();
        releasePolicy();
      } else if (cancel) controller.abort();
      const result = await outcome;
      if (cancel) assert(result.error);
      else assert.equal(JSON.parse(result.result.content[0].text).status, "approval_expired");
      if (respond) respond({ action: "accept", content: { approve: true } });
      await new Promise((r) => setTimeout(r, 30));
      check(
        cancel
          ? `cancelled approval cannot execute after late acceptance (${mode})`
          : "expired approval cannot execute after late acceptance",
        executions === 0
      );
      const replay = JSON.parse(
        (await client.callTool({ name: "gno_confirm", arguments: { token: p.approval_token } })).content[0]
          .text
      );
      check("failed approval consumes its token", replay.status === "invalid_token" && executions === 0);
    } finally {
      await client.close();
      await server.close();
    }
  }
});
