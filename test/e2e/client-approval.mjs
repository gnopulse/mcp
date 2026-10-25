// Trusted host approval without form elicitation. All transaction services are offline mocks.
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_APPROVAL_META, signClientApproval } from "../../dist/signer/clientApproval.js";
import { check, run, serverEnv, startMock, startStdioClient } from "./lib.mjs";
await run(async () => {
  const dir = mkdtempSync(join(tmpdir(), "gp-approval-"));
  const keys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  const keyfile = join(dir, "host.pub");
  writeFileSync(keyfile, keys.publicKey);
  let executions = 0;
  const service = await startMock((req) => {
    if (req.url === "/simulate")
      return {
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
    if (req.url === "/execute") {
      executions++;
      return { ok: true, tx_hash: "HOST_APPROVED", height: 12 };
    }
    return { error: "unexpected" };
  });
  const client = await startStdioClient(
    serverEnv({
      GNOPULSE_SIGNER: "user-approval",
      GNOTX_SERVICE_URL: service.url,
      GNOPULSE_APPROVAL_PUBLIC_KEY_FILE: keyfile
    })
  );
  const propose = () =>
    client.callTool("gno_call", { pkgpath: "gno.land/r/demo/x", func: "Ping", args: ["original"] });
  const confirm = async (p, receipt) => {
    const msg = await client.request("tools/call", {
      name: "gno_confirm",
      arguments: { token: p.approval_token },
      _meta: { [CLIENT_APPROVAL_META]: receipt }
    });
    return JSON.parse(msg.result.content[0].text);
  };
  try {
    const p = await propose();
    check("proposal supplies a bound challenge", p.approval_challenge?.intent.args[0] === "original");
    const signed = signClientApproval(p.approval_challenge, keys.privateKey, "approve");
    const ok = await confirm(p, signed);
    check(
      "trusted client can authorize without form capability",
      ok.status === "executed" && executions === 1
    );
    check("receipt is single use", (await confirm(p, signed)).status === "invalid_token" && executions === 1);
    for (const [label, alter] of [
      ["model approval flag", () => ({ approved: true })],
      [
        "different transaction",
        (r) => {
          r.challenge.intent.args[0] = "changed";
          return r;
        }
      ],
      [
        "different wallet",
        (r) => {
          r.challenge.wallet = "other";
          return r;
        }
      ],
      [
        "different fee",
        (r) => {
          r.challenge.intent.executionLimits.feeUgnot = "1";
          return r;
        }
      ],
      [
        "wrong key",
        (_r, p) =>
          signClientApproval(
            p.approval_challenge,
            generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" } })
              .privateKey,
            "approve"
          )
      ],
      ["human decline", (_r, p) => signClientApproval(p.approval_challenge, keys.privateKey, "deny")]
    ]) {
      const p = await propose();
      const receipt = alter(signClientApproval(p.approval_challenge, keys.privateKey, "approve"), p);
      check(
        `${label} never executes`,
        (await confirm(p, receipt)).status === "approval_denied" && executions === 1
      );
    }
    const foreign = await propose();
    const wrongProposal = await propose();
    check(
      "receipt cannot move between proposals",
      (
        await confirm(
          foreign,
          signClientApproval(wrongProposal.approval_challenge, keys.privateKey, "approve")
        )
      ).status === "approval_denied" && executions === 1
    );
    const noReceipt = await propose();
    check(
      "unsupported client without authorization fails closed",
      (await client.callTool("gno_confirm", { token: noReceipt.approval_token })).status ===
        "approval_unavailable" && executions === 1
    );
  } finally {
    client.close();
    service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
