/** Host-side adapter. Never expose this function or its authorization key as a model tool. */
import { CLIENT_APPROVAL_META, signClientApproval } from "@gnopulse/mcp/dist/signer/clientApproval.js";

/**
 * requestHumanApproval is the host's authenticated user-interaction callback. It can
 * display a native chat confirmation, approval card or terminal prompt. It must not
 * ask the model whether consent occurred, or auto-accept based on model output.
 */
export async function confirmWithHuman({ client, proposal, privateKeyPem, requestHumanApproval }) {
  if (proposal.status !== "awaiting_approval" || !proposal.approval_challenge)
    throw new Error("The server did not provide a client authorization challenge.");
  const challenge = proposal.approval_challenge;
  const accepted = await requestHumanApproval({
    wallet: challenge.wallet,
    chain: challenge.chain,
    transaction: challenge.intent,
    simulation: proposal.simulate,
    expiresAt: challenge.expiresAt
  });
  if (accepted !== true) return { status: "approval_declined" };
  const receipt = signClientApproval(challenge, privateKeyPem, "approve");
  return client.callTool({
    name: "gno_confirm",
    arguments: { token: challenge.token },
    _meta: { [CLIENT_APPROVAL_META]: receipt }
  });
}
