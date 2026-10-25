// All cases use local mocks. No real wallets or broadcasts.
import { check, run, serverEnv, startMock, startStdioClient } from "./lib.mjs";
const expected = "g1expected-wallet";
const router = "gno.land/r/gnoswap/router";
const swap = {
  tokenIn: "gno.land/r/demo/a",
  tokenOut: "gno.land/r/demo/b",
  amountIn: "123",
  minOut: "100",
  fee: "500",
  deadlineSecs: 120
};
const parse = (r) => JSON.parse(r.result.content[0].text);
await run(async () => {
  let requests = [],
    accountReads = 0,
    identity = { caller: expected, chainid: "onyx-1" };
  const backend = await startMock((req, body) => {
    if (req.url === "/healthz")
      return { ok: true, ...identity, unsigned_simulation: true, execution_enabled: true };
    requests.push({ path: req.url, body });
    if (req.url === "/simulate")
      return {
        mode: "simulate",
        ok: true,
        gas_used: 100000,
        gas_wanted: 130000,
        extra: {
          estimated_fee_ugnot: "100000",
          estimated_storage_deposit_ugnot: "0",
          storage_deposit_limit_ugnot: "1",
          estimated_storage_refund_ugnot: "0",
          estimated_total_fee_ugnot: "100001"
        }
      };
    if (req.url === "/execute") return { mode: "broadcast", ok: true, tx_hash: "MOCK" };
    return { error: "unexpected request" };
  });
  const rpc = await startMock(() => {
    accountReads++;
    const data = Buffer.from(
      JSON.stringify({ address: expected, coins: "0ugnot", sequence: "0", account_number: "9" })
    ).toString("base64");
    return { result: { response: { ResponseBase: { Data: data } } } };
  });
  const env = (extra) =>
    serverEnv({
      GNO_CHAIN_ID: "onyx-1",
      GNOPULSE_AGENT_ADDRESS: expected,
      GNOTX_SERVICE_URL: backend.url,
      GNOPULSE_SIGNER: "microservice",
      GNOPULSE_POLICY_MAX_SEND_UGNOT: "0",
      GNOPULSE_POLICY_MAX_FEE_UGNOT: "1000000",
      GNOPULSE_POLICY_MAX_GAS: "20000000",
      GNOPULSE_POLICY_EXPIRES_IN: "60",
      GNOPULSE_POLICY_DEFAULT: "deny",
      GNOPULSE_POLICY_ALLOW_REALMS: router,
      GNOPULSE_POLICY_ALLOW_FUNCS: "ExactInSwapRoute",
      ...extra
    });
  try {
    for (const rule of [
      { GNOPULSE_POLICY_DENY_REALMS: router },
      { GNOPULSE_POLICY_DENY_FUNCS: "ExactInSwapRoute" }
    ]) {
      requests = [];
      const c = await startStdioClient(env(rule));
      try {
        const reply = await c.callTool("gno_swap", swap);
        check(
          "swap deny rules reject before preview",
          reply.status === "policy_denied" && requests.length === 0,
          JSON.stringify(reply)
        );
      } finally {
        c.close();
      }
    }
    requests = [];
    let consent;
    const human = await startStdioClient(env({ GNOPULSE_SIGNER: "user-approval" }), async (params) => {
      consent = params.message;
      return { action: "accept", content: { approve: true } };
    });
    try {
      const proposal = await human.callTool("gno_swap", swap);
      check(
        "allowlisted swap reaches human approval",
        proposal.status === "awaiting_approval",
        JSON.stringify(proposal)
      );
      const preview = requests.find((r) => r.path === "/simulate");
      await new Promise((r) => setTimeout(r, 1100));
      const result = await human.callTool("gno_confirm", { token: proposal.approval_token });
      const execute = requests.find((r) => r.path === "/execute");
      check(
        "approved swap executes only once",
        result.status === "executed" && requests.filter((r) => r.path === "/execute").length === 1
      );
      check(
        "policy preview and execution use the actual router",
        preview?.body.pkgpath === router &&
          execute?.body.pkgpath === router &&
          preview.body.func === "ExactInSwapRoute" &&
          execute.body.func === "ExactInSwapRoute"
      );
      check(
        "swap arguments including deadline remain identical after consent",
        JSON.stringify(preview?.body.args) === JSON.stringify(execute?.body.args)
      );
      check(
        "consent names the actual router and function",
        consent?.includes(router) && consent.includes("ExactInSwapRoute")
      );
    } finally {
      human.close();
    }
    requests = [];
    const autonomous = await startStdioClient(env({}));
    try {
      const reply = await autonomous.callTool("gno_swap", swap);
      check(
        "valid allowlisted autonomous swap works",
        reply.status === "executed" && requests.some((r) => r.path === "/execute"),
        JSON.stringify(reply)
      );
    } finally {
      autonomous.close();
    }
    const client = await startStdioClient(
      env({
        GNO_RPC_URLS: rpc.url,
        GNOPULSE_SIGNER: "user-approval",
        GNOPULSE_POLICY_ALLOW_REALMS: "gno.land/r/demo/x",
        GNOPULSE_POLICY_ALLOW_FUNCS: "Ping"
      })
    );
    try {
      for (const bad of [
        { caller: "g1foreign-wallet", chainid: "onyx-1" },
        { caller: expected, chainid: "gnoland-1" }
      ]) {
        identity = bad;
        requests = [];
        accountReads = 0;
        for (const [name, args] of [
          ["gno_agent_status", {}],
          ["gno_call", { pkgpath: "gno.land/r/demo/x", func: "Ping" }],
          ["gno_simulate", { pkgpath: "gno.land/r/demo/x", func: "Ping" }]
        ]) {
          const reply = await client.request("tools/call", { name, arguments: args });
          check(
            `${name} rejects changed wallet or chain without funding guidance`,
            reply.result?.isError === true &&
              !JSON.stringify(reply).includes("needs_funding") &&
              !JSON.stringify(reply).includes("g1foreign-wallet"),
            JSON.stringify(reply)
          );
        }
        check(
          "identity mismatch never reaches balance lookup, simulate or execute",
          requests.length === 0 && accountReads === 0
        );
      }
    } finally {
      client.close();
      identity = { caller: expected, chainid: "onyx-1" };
    }
    const fundedStatus = await startStdioClient(
      env({
        GNO_RPC_URLS: rpc.url,
        GNOPULSE_SIGNER: "user-approval",
        GNOPULSE_POLICY_ALLOW_REALMS: "gno.land/r/demo/x",
        GNOPULSE_POLICY_ALLOW_FUNCS: "Ping"
      })
    );
    try {
      const status = await fundedStatus.callTool("gno_agent_status");
      const proposal = await fundedStatus.callTool("gno_call", {
        pkgpath: "gno.land/r/demo/x",
        func: "Ping"
      });
      check(
        "verified empty wallet retains correct funding guidance",
        status.address === expected &&
          status.balance_ugnot === "0" &&
          proposal.status === "needs_funding" &&
          proposal.address === expected
      );
      identity = { ok: false, caller: expected, chainid: "onyx-1" };
      const unavailable = await fundedStatus.callTool("gno_agent_status");
      const stopped = await fundedStatus.callTool("gno_call", { pkgpath: "gno.land/r/demo/x", func: "Ping" });
      check(
        "backend outage is not misreported as an empty wallet",
        unavailable.balance_ugnot === null &&
          !unavailable.next_steps.join().includes("Ask the user to fund") &&
          stopped.status === "simulate_failed"
      );
    } finally {
      fundedStatus.close();
      identity = { caller: expected, chainid: "onyx-1" };
    }
    const noWallet = await startStdioClient(
      env({ GNOPULSE_SIGNER: "none", GNOPULSE_AGENT_ADDRESS: "", GNOPULSE_AGENT_ID: "" })
    );
    try {
      const status = await noWallet.callTool("gno_agent_status");
      check(
        "an unconfigured agent never adopts a service wallet",
        status.address === null && status.chain === "onyx-1"
      );
    } finally {
      noWallet.close();
    }
  } finally {
    backend.close();
    rpc.close();
  }
});
