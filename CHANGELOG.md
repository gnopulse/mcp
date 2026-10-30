# Changelog

## 0.3.7 (2026-10-30)

From the first end-to-end agent wallet run on mainnet.

- Approved and autonomous transactions can be sent. 0.3.6 refused every one with "gas estimate exceeds the approved preview": the signer re-estimated gas for a transaction that now carried its storage ceiling, which costs slightly more. An approved execution now signs at the approved gas limit.
- Auto fees follow the chain's gas price instead of a fixed rate tuned for an old testnet. On gnoland-1 that is about 12 times cheaper: a GNOT wrap paid 0.18 GNOT in gas and now pays 0.017, a swap 3 GNOT and now 0.27. The minimum fee is 0.01 GNOT, down from 0.1.
- A new agent wallet reads as unfunded, with its address, in `gno_agent_status` and in every write tool. It used to read as "balance unavailable" and the write tools failed with "unknown address".
- `gno_swap` accepts a bare realm (`gno.land/r/gnoswap/gns`) and resolves it to its registry key, takes `route` and `quote` from `gno_dex_route`, and explains that native GNOT must be wrapped first.

## 0.3.6 (2026-10-30)

- `gno_token_metadata` and `gno_token_balance` accept a realm path that registers one token (`gno.land/r/gnoswap/gns`) as well as its registry key, name the keys when a realm registers several, and point native `ugnot` to `gno_get_balances` and `gno_prices`.
- Refused calls say when to retry and what is left: the error carries the `Retry-After` wait, the prepaid credit balance and the daily units remaining. `x-credits-remaining` is passed through with the other limit headers.

## 0.3.5 (2026-10-28)

- With `GNOPULSE_SIGNER=none` the write tools (`gno_call`, `gno_swap`, `gno_approve`, `gno_deploy`, `gno_confirm`) are no longer listed; they could only answer "execution disabled". `gno_agent_status` names them and how to enable them. The capability manifest marks them `requires: signer`.

## 0.3.4 (2026-10-28)

- Wait for results the API is still computing (a cold wallet's token balances, for example) instead of returning its empty placeholder; still pending after 25 seconds is an error. Pending answers are not billed.
- Chain query failures are tool errors with the node's one-line message: `gno_render` and `gno_eval` on a missing package, `gno_package_files` on an unknown path, `gno_get_balances` on a malformed address. An address with no account is still a zero-balance result.

## 0.3.3 (2026-10-28)

- Add 36 read tools covering the rest of the v2 API: recent blocks, governance proposals and votes, validators, bridges and bridge transfers, GNOT wraps, realm graph, discoveries, libraries, GPAO queue, DEX analytics, volume series, pool candles, pool trades, multi-hop legs, swap quotes and routes, token directory, all prices, launchpad markets and quotes, launch snipers, CVD, wallet flows, known entities, wallet DeFi, wallet realms, wallet cluster, realms, functions, failed calls, sparklines and health. Requires the matching API release.
- `gno_pools` returns each pool's TVL, volume and APR under `market`, dated by `market_as_of`.
- List results pass through `ignored_params` when the API did not apply a parameter.

## 0.3.2 (2026-10-27)

- Align the LP tool event cursor with its event continuation flag; expose separate contributor continuation and next offset. Retain the distribution bundle.

- Support trusted hosted usage reservations and completion. Withhold useful output if completion cannot be committed; release failed tools. Keep local public-RPC tools independent of hosted accounting.
- Preserve LP bundle compatibility and expose event cursors and contributor offsets, nullable estimates and separately verified ownership. Requires the matching v2 producer/reader rollout.
- Scope placeholder-decimal corrections to verified networks; Onyx wrapped GNOT uses six effective display decimals with unchanged raw units.
- Publish a versioned capability manifest checked against actual tool registration and transport restrictions.

- Add optional limit/cursor inputs to NFT holdings, preserving the address-only default and whole-owner metadata. Reject unsupported or stalled continuation instead of repeating the first page. Requires the API NFT cursor release before rollout.

## 0.3.1

- Clarify that token and NFT collection inputs use identifiers returned by discovery tools, rather than bare realm paths.

- Preserve holder-distribution bundle fields while reporting its actual continuation, total and advancing next_offset at the MCP page level. Reject contradictory pagination instead of silently ending a holder scan.

## 0.3.0 (2026-10-25)

- Fail closed for hosted chain/simulation tools when usage authorization is unavailable or malformed. Keep local public-RPC reads independent of hosted metering availability.

- Replace raw approval JSON with a factual transaction summary, exact native amounts, separate gas/storage costs and technical call details. Keep explicit signing authorization unchecked by default and explain that Accept alone sends nothing.
- Include gross storage deposits in fee-policy and approval bounds, keep refunds separate, reject incomplete gas-only previews, and enforce the storage ceiling in signed MsgCall.MaxDeposit. Require matching total-fee and storage bounds on execution requests.

- Bound client elicitation by proposal expiry rather than the SDK default timeout, propagate call cancellation and report incomplete approval without signing. Reject late consent after expiry or cancellation.

- Add a Codex local-source configuration with explicit Onyx pointers and signing disabled; document native MCP elicitation compatibility without an additional host authorization key.

- Support trusted client authorization of exact expiring proposals via signed host receipts, with MCP elicitation as a fallback. Keep the authorization key outside model tools; reject changed, forged or replayed receipts.
- Require autonomous grants to specify realm/function allowlists, native-send, fee and gas limits, and an expiry. Check gas and fee bounds after preview; reject incomplete grants before launcher wallet/service creation.

- Share concrete swap targets and arguments across policy, simulation, consent and execution. Enforce router/function allow and deny rules for swaps.
- Verify configured wallet and chain before status or funding guidance, and never adopt a backend wallet for an unconfigured client. Report unavailable balance separately from zero balance.

- Default local signing to disabled; namespace persistent wallets by explicit agent ID and chain, without reusing legacy wallets implicitly.
- Simulate ordinary realm calls using public metadata and placeholder signatures, with no signed fallback or startup password-validation signature. Require matching RPC chain and caller identity.
- Require explicit authenticated service execution permission. Gate human approval through client form elicitation; reject unsupported, refused, cancelled, expired and reused proposals. Preserve exact swap deadlines and snapshot proposal arguments.
- Check policy before preview and again after consent. Failed simulation cannot authorize execution. Advertise simulation only with a healthy compatible backend; hosted previews require a caller and never expose execution tools.
- Document local operator/client trust boundaries and the separate signed deployment flow.


## 0.2.3 (2026-10-24)

- Retain bounded-list offsets, totals and continuation metadata, expose real response quota headers and add `gno_api_usage` with its normal request cost.
- Surface application errors inside HTTP-200 responses as tool errors.
- Read versioned wash and same-block sandwich snapshots for 1, 7 and 30 days, with explicit coverage and detection limitations.
- Support signer-free local reads with `GNOPULSE_SIGNER=none`.

- Add cursor paging to settled swap signals while retaining deprecated offsets. Fail
  explicitly if a cursor call reaches an older API without the cursor contract.

- Allocate an independent loopback signer endpoint per launcher. Refuse occupied fixed
  endpoints instead of sharing a process another client owns. Cover both concurrent-client
  shutdown orders, EOF and termination, without leaving owned signers behind.
- Publish newly generated keybase secrets atomically so concurrent launchers cannot read
  an incompletely written secret or overwrite one another's credentials.

- Restrict HTTP tool discovery and direct invocation to reads, agent status and simulation.
- Stop the launcher-owned signer on normal client exit and termination, leaving refused preexisting signers untouched.
- Respect an explicitly configured policy default in the launcher.
- Document explicit Onyx API, RPC, chain and isolated wallet configuration for integration tests.
- Update Zod to 4.6.7 and body-parser to 2.4.0 for their denial-of-service fixes, with the tested SDK floor at 1.32.2.
