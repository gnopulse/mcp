// User-approval signer: writes return an approval token, broadcast only on confirm,
// tokens are single-use, and policy rules apply before any approval is issued.
import { check, run, serverEnv, startMock, startStdioClient } from "./lib.mjs";

await run(async () => {
  let executeHits = 0;
  const signer = await startMock((req) => {
    if (req.url === "/simulate") return { mode: "simulate", ok: true, gas_used: 100000 };
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
    }),
  );
  try {
    const proposed = await client.callTool("gno_call", { pkgpath: "gno.land/r/demo/ok", func: "Ping", args: ["x"] });
    check("propose awaits approval", proposed.status === "awaiting_approval" && Boolean(proposed.approval_token), proposed.status);
    check("propose does not broadcast", executeHits === 0);

    const confirmed = await client.callTool("gno_confirm", { token: proposed.approval_token });
    check("confirm executes once", confirmed.status === "executed" && executeHits === 1, confirmed.status);
    check("confirm returns the tx hash", confirmed.result?.txHash === "ABC123");

    const reused = await client.callTool("gno_confirm", { token: proposed.approval_token });
    check("token is single-use", reused.status === "invalid_token" && executeHits === 1, reused.status);

    const denied = await client.callTool("gno_call", { pkgpath: "gno.land/r/demo/blocked", func: "Ping" });
    check("denylisted realm is refused", denied.status === "policy_denied", denied.reason);

    const overCap = await client.callTool("gno_call", { pkgpath: "gno.land/r/demo/ok", func: "Buy", send: "2000000ugnot" });
    check("send over the cap is refused", overCap.status === "policy_denied", overCap.reason);
  } finally {
    client.close();
    signer.close();
  }
});
