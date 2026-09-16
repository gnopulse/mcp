// Simulate-only mode (no signer): gno_simulate reaches the signing service,
// gno_call is refused without broadcasting, and the chain id falls back to config.
import { check, run, serverEnv, startMock, startStdioClient } from "./lib.mjs";

await run(async () => {
  const hits = [];
  const signer = await startMock((req, body) => {
    hits.push(req.url);
    if (req.url === "/simulate") {
      return { mode: "simulate", ok: true, gas_used: 123456, func: `${body.pkgpath}.${body.func}`, return: ["(42 int64)"] };
    }
    return { error: `unexpected ${req.url}` };
  });
  const client = await startStdioClient(serverEnv({ GNOTX_SERVICE_URL: signer.url }));
  try {
    const sim = await client.callTool("gno_simulate", { pkgpath: "gno.land/r/demo/x", func: "Foo", args: ["a"] });
    check("gno_simulate calls /simulate", hits.includes("/simulate"));
    check("gno_simulate returns the envelope", sim.gas_used === 123456 && sim.func === "gno.land/r/demo/x.Foo", JSON.stringify(sim));

    const call = await client.callTool("gno_call", { pkgpath: "gno.land/r/demo/x", func: "Foo" });
    check("gno_call is denied without a signer", call.status === "policy_denied", call.status);
    check("gno_call never calls /execute", !hits.includes("/execute"));
  } finally {
    client.close();
    signer.close();
  }

  // Signer unreachable: the chain falls back to GNO_CHAIN_ID, and mainnet never shows a faucet.
  for (const [chainId, faucet] of [[undefined, null], ["test13", "https://faucet.gno.land"]]) {
    const offline = await startStdioClient(
      serverEnv({ GNOTX_SERVICE_URL: "http://127.0.0.1:9", ...(chainId && { GNO_CHAIN_ID: chainId }) }),
    );
    try {
      const { chain, faucet: shown } = await offline.callTool("gno_agent_status");
      const expected = chainId ?? "gnoland-1";
      check(`signer down: chain falls back to ${expected}`, chain === expected && shown === faucet, `${chain} ${shown}`);
    } finally {
      offline.close();
    }
  }
});
