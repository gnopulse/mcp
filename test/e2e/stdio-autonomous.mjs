// Autonomous signers: execute without a token under a restrictive policy, refuse to start
// with a wide-open policy, and no signer of any kind starts over HTTP.
import { check, freePort, run, runToExit, serverEnv, startMock, startStdioClient } from "./lib.mjs";

await run(async () => {
  let executeHits = 0;
  const signer = await startMock((req) => {
    if (req.url === "/simulate") return { mode: "simulate", ok: true, gas_used: 100000 };
    if (req.url === "/execute") {
      executeHits++;
      return { mode: "broadcast", ok: true, tx_hash: "TX1", height: 7 };
    }
    return { error: `unexpected ${req.url}` };
  });
  const env = (overrides) => serverEnv({ GNOTX_SERVICE_URL: signer.url, ...overrides });

  try {
    const client = await startStdioClient(
      env({
        GNOPULSE_SIGNER: "microservice",
        GNOPULSE_POLICY_ALLOW_REALMS: "gno.land/r/demo/ok",
        GNOPULSE_POLICY_MAX_SEND_UGNOT: "1000000",
      }),
    );
    try {
      const result = await client.callTool("gno_call", { pkgpath: "gno.land/r/demo/ok", func: "Ping" });
      check("microservice executes immediately", result.status === "executed" && executeHits === 1, result.status);
      check("microservice returns the tx hash", result.result?.txHash === "TX1");
    } finally {
      client.close();
    }

    for (const kind of ["microservice", "tee"]) {
      const { code, stderr } = await runToExit(env({ GNOPULSE_SIGNER: kind }));
      check(`${kind} with an unbounded policy refuses to start`, code === 1 && /does not bound/.test(stderr), stderr.trim());
    }

    const denyOnly = await runToExit(
      env({ GNOPULSE_SIGNER: "microservice", GNOPULSE_POLICY_DENY_REALMS: "gno.land/r/x", GNOPULSE_POLICY_EXPIRES_IN: "60" }),
    );
    check("deny list and expiry alone refuse to start", denyOnly.code === 1 && /does not bound/.test(denyOnly.stderr), denyOnly.stderr.trim());

    // A native-ugnot bound is not a bound on what may be called: a GRC20 transfer is a call with
    // an empty send and passes both of these.
    for (const over of [{ GNOPULSE_POLICY_MAX_SEND_UGNOT: "1000000" }, { GNOPULSE_POLICY_FEES_ONLY: "1" }]) {
      const nativeOnly = await runToExit(env({ GNOPULSE_SIGNER: "microservice", ...over }));
      check(
        `${Object.keys(over)[0]} alone refuses to start`,
        nativeOnly.code === 1 && /does not bound/.test(nativeOnly.stderr),
        nativeOnly.stderr.trim(),
      );
    }

    const badCap = await runToExit(env({ GNOPULSE_SIGNER: "microservice", GNOPULSE_POLICY_MAX_SEND_UGNOT: "5gnot" }));
    const named = /GNOPULSE_POLICY_MAX_SEND_UGNOT="5gnot" is invalid/.test(badCap.stderr);
    check("malformed policy variable fails naming it", badCap.code === 1 && named, badCap.stderr.trim());

    // Restrictive policy, so the refusal can only come from the transport.
    for (const kind of ["user-approval", "microservice", "tee"]) {
      const overHttp = await runToExit(
        env({
          GNOPULSE_SIGNER: kind,
          GNOPULSE_POLICY_DEFAULT: "deny",
          GNOPULSE_MCP_TRANSPORT: "http",
          GNOPULSE_MCP_PORT: String(await freePort()),
        }),
      );
      const refused = overHttp.code === 1 && /not allowed over HTTP/.test(overHttp.stderr);
      check(`${kind} over HTTP refuses to start`, refused, overHttp.stderr.trim());
    }
  } finally {
    signer.close();
  }
});
