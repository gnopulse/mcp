// User-approval signer: writes return an approval token, broadcast only on confirm,
// tokens are single-use, and policy rules apply before any approval is issued.
import { check, run, serverEnv, startMock, startStdioClient } from "./lib.mjs";

await run(async () => {
  let executeHits = 0;
  let simulateHits = 0;
  let simulateFails = false;
  let costOverride;
  let presented;
  const signer = await startMock((req) => {
    if (req.url === "/simulate") {
      simulateHits++;
      return {
        mode: "simulate",
        ok: !simulateFails,
        gas_used: 100000,
        gas_wanted: 130000,
        extra: costOverride ?? {
          estimated_fee_ugnot: "100000",
          estimated_storage_deposit_ugnot: "0",
          storage_deposit_limit_ugnot: "1",
          estimated_storage_refund_ugnot: "0",
          estimated_total_fee_ugnot: "100001"
        }
      };
    }
    if (req.url === "/execute") {
      executeHits++;
      return { mode: "broadcast", ok: true, tx_hash: "ABC123", height: 42 };
    }
    return { error: `unexpected ${req.url}` };
  });
  const client = await startStdioClient(
    serverEnv({
      GNOPULSE_SIGNER: "user-approval",
      GNOTX_SERVICE_URL: signer.url,
      GNOPULSE_POLICY_DENY_REALMS: "gno.land/r/demo/blocked",
      GNOPULSE_POLICY_MAX_SEND_UGNOT: "1000000",
      GNOPULSE_POLICY_MAX_FEE_UGNOT: "260000"
    }),
    async (request) => {
      presented = request;
      return { action: "accept", content: { approve: true } };
    }
  );
  try {
    const proposed = await client.callTool("gno_call", {
      pkgpath: "gno.land/r/demo/ok",
      func: "Ping",
      args: ["x"]
    });
    check(
      "propose awaits approval",
      proposed.status === "awaiting_approval" && Boolean(proposed.approval_token),
      proposed.status
    );
    check("propose does not broadcast", executeHits === 0);

    const confirmed = await client.callTool("gno_confirm", {
      token: proposed.approval_token
    });
    check("confirm executes once", confirmed.status === "executed" && executeHits === 1, confirmed.status);
    check("confirm returns the tx hash", confirmed.result?.txHash === "ABC123");
    check(
      "approval presents understandable costs before exact arguments",
      presented.message.indexOf("Maximum gas + storage debit") <
        presented.message.indexOf("Technical details:")
    );
    check(
      "authorization checkbox stays explicit and unchecked",
      presented.requestedSchema.properties.approve.default === false &&
        presented.requestedSchema.properties.approve.title === "Yes, sign and send this transaction"
    );
    for (const [name, extra, status] of [
      ["gas-only legacy backend", { estimated_fee_ugnot: "100000" }, "simulate_failed"],
      [
        "storage pushes total over policy cap",
        {
          estimated_fee_ugnot: "100000",
          estimated_storage_deposit_ugnot: "206100",
          storage_deposit_limit_ugnot: "206100",
          estimated_storage_refund_ugnot: "900000",
          estimated_total_fee_ugnot: "306100"
        },
        "policy_denied"
      ],
      [
        "contradictory total",
        {
          estimated_fee_ugnot: "100000",
          estimated_storage_deposit_ugnot: "206100",
          storage_deposit_limit_ugnot: "206100",
          estimated_storage_refund_ugnot: "0",
          estimated_total_fee_ugnot: "100000"
        },
        "simulate_failed"
      ]
    ]) {
      costOverride = extra;
      const refused = await client.callTool("gno_call", { pkgpath: "gno.land/r/demo/ok", func: "Ping" });
      check(
        `${name} cannot issue approval or execute`,
        refused.status === status && !refused.approval_token && executeHits === 1,
        refused.status
      );
    }
    costOverride = undefined;

    const reused = await client.callTool("gno_confirm", {
      token: proposed.approval_token
    });
    check("token is single-use", reused.status === "invalid_token" && executeHits === 1, reused.status);

    simulateFails = true;
    const failed = await client.callTool("gno_call", {
      pkgpath: "gno.land/r/demo/ok",
      func: "Fail"
    });
    check(
      "failed simulation cannot issue approval",
      failed.status === "simulate_failed" && !failed.approval_token && executeHits === 1
    );
    simulateFails = false;
    const beforeDenied = simulateHits;
    const denied = await client.callTool("gno_call", {
      pkgpath: "gno.land/r/demo/blocked",
      func: "Ping"
    });
    check("denylisted realm is refused", denied.status === "policy_denied", denied.reason);

    check(
      "policy denial does not reach simulation or signing",
      simulateHits === beforeDenied && executeHits === 1
    );
    const overCap = await client.callTool("gno_call", {
      pkgpath: "gno.land/r/demo/ok",
      func: "Buy",
      send: "2000000ugnot"
    });
    check("send over the cap is refused", overCap.status === "policy_denied", overCap.reason);
    for (const [label, consent] of [
      ["unsupported client", undefined],
      ["declined", async () => ({ action: "decline" })],
      ["unchecked", async () => ({ action: "accept", content: { approve: false } })]
    ]) {
      const other = await startStdioClient(
        serverEnv({
          GNOPULSE_SIGNER: "user-approval",
          GNOTX_SERVICE_URL: signer.url
        }),
        consent
      );
      try {
        const proposal = await other.callTool("gno_call", {
          pkgpath: "gno.land/r/demo/ok",
          func: "Ping"
        });
        // A client that cannot show forms is refused at the proposal, with nothing to confirm.
        const reply = proposal.approval_token
          ? await other.callTool("gno_confirm", { token: proposal.approval_token })
          : proposal;
        check(
          `${label} cannot sign or broadcast`,
          ["approval_unavailable", "approval_declined"].includes(reply.status) && executeHits === 1,
          reply.status
        );
      } finally {
        other.close();
      }
    }
  } finally {
    client.close();
    signer.close();
  }
});
