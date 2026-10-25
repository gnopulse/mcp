# Changelog

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
