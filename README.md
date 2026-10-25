# GnoPulse MCP

[![ci](https://github.com/gnopulse/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/gnopulse/mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@gnopulse/mcp)](https://www.npmjs.com/package/@gnopulse/mcp)

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents read, analyze and transact on [gno.land](https://gno.land).

- **42 tools**: chain reads, wallets, tokens, NFTs, pools, and on-chain analytics from [GnoPulse](https://gnopulse.xyz).
- **Local signing**: keys stay in `gnotx`, a local signer process. The model and the MCP server never see them.
- **Human approval by default**: every write is simulated and policy-checked, and nothing is broadcast until you confirm it.

## Quick start

### Hosted: read, analyze, simulate

No install. Get an API key at [gnopulse.xyz](https://gnopulse.xyz), then add:

```json
{
  "mcpServers": {
    "gnopulse": {
      "url": "https://mcp.gnopulse.xyz/mcp",
      "headers": { "X-API-Key": "YOUR_KEY" }
    }
  }
}
```

The hosted server holds no keys, so it cannot sign. The HTTP transport serves read and simulate tools only.

### Local: execute on chain

```json
{
  "mcpServers": {
    "gnopulse": { "command": "npx", "args": ["-y", "@gnopulse/mcp"] }
  }
}
```

On first start the launcher:

1. Uses the prebuilt `gnotx` binary for your platform (macOS, Linux, Windows; x64 and arm64), installed as an optional npm dependency.
2. Creates a dedicated agent key in `~/.gnopulse-agent`.
3. Starts `gnotx serve` on `127.0.0.1` with a random session token. Each launcher allocates an independent loopback port and stops only its own signer when the MCP client exits or is interrupted. Concurrent clients retain the same persistent wallet but cannot interrupt each other's signer. An explicitly configured occupied port is refused, including a matching signer.
4. Serves every tool over stdio, with human-approval signing.

Ask the agent for its wallet status to get its address, then fund it. This is gnoland-1 mainnet with real GNOT, so use a dedicated wallet and fund only what the agent needs.

Examples for ElizaOS, LangChain, the OpenAI Agents SDK and the Vercel AI SDK are in [`adapters/`](adapters).

## How execution works

```
agent ──▶ gno_call / gno_swap / gno_approve
            │  simulate + policy check
            ▼
          preview + approval token      (nothing broadcast)
            │  user confirms
            ▼
          gno_confirm ──▶ gnotx signs and broadcasts
```

Set `GNOPULSE_SIGNER=microservice` to execute without a confirmation step. The server refuses to start in that mode unless the policy bounds spending or scope (a realm or function allow list, a send cap, fees only, or default deny). Deny lists and expiry alone are not enough. `GNOPULSE_SIGNER=tee` behaves the same, for a `gnotx serve` that uses an external signer backend (local mnemonic or Turnkey).

## Tools

| Area | Tools |
|---|---|
| Chain | `gno_status` `gno_get_block` `gno_get_transactions` `gno_get_events` `gno_get_account` `gno_get_balances` `gno_eval` `gno_render` `gno_get_package` `gno_package_files` `gno_search` |
| Tokens | `gno_token_registry` `gno_token_metadata` `gno_token_balance` `gno_token_holders` `gno_holder_series` `gno_prices` `gno_ohlcv` |
| Wallets | `gno_wallet_tokens` `gno_wallet_transfers` `gno_wallet_pnl` `gno_label` `gno_whales` |
| NFTs | `gno_grc721` `gno_nft_holdings` `gno_nft_collection` |
| DEX | `gno_pools` `gno_pool_depth` `gno_pool_lp_providers` |
| Analytics | `gno_smart_money` `gno_swap_signals` `gno_launch_radar` `gno_mev` `gno_wash_trades` `gno_dev_activity` |
| Execution | `gno_agent_status` `gno_simulate` `gno_call` `gno_swap` `gno_approve` `gno_deploy` `gno_confirm` |

Data and analytics tools call the GnoPulse API with `GNOPULSE_API_KEY`.

## Configuration

All optional.

| Variable | Default | |
|---|---|---|
| `GNOPULSE_API_KEY` | | GnoPulse API key |
| `GNOPULSE_API_BASE` | `https://gnopulse.xyz` | GnoPulse API base URL |
| `GNO_RPC_URLS` | public gnoland-1 RPCs | Comma-separated RPC endpoints, tried in order |
| `GNO_CHAIN_ID` | `gnoland-1` | Also passed to the signer by the launcher |
| `GNO_GRC20_REGISTRY` | `gno.land/r/nt/grc20reg/v0` | GRC20 registry realm |
| `GNOPULSE_SIGNER` | `user-approval` with `npx`, else `none` | `user-approval`, `microservice`, `tee`, or `none` (simulate only) |
| `GNOPULSE_POLICY_MAX_SEND_UGNOT` | `5000000` with `npx`, else none | Maximum native ugnot sent per transaction. Does not cover GRC20 approve or swap amounts |
| `GNOPULSE_POLICY_ALLOW_REALMS` | | Only these realms (comma-separated) |
| `GNOPULSE_POLICY_DENY_REALMS` | | Never these realms |
| `GNOPULSE_POLICY_ALLOW_FUNCS` | | Only these functions (comma-separated) |
| `GNOPULSE_POLICY_DENY_FUNCS` | | Never these functions |
| `GNOPULSE_POLICY_DEFAULT` | `allow` | `deny` rejects every call when no allow rule is set |
| `GNOPULSE_POLICY_FEES_ONLY` | | `1` denies any non-zero native send. Like the cap above, it does not cover a GRC20 transfer, which is a call with an empty send |
| `GNOPULSE_POLICY_EXPIRES_IN` / `_AT` | | Session expiry in seconds, or a unix time |
| `GNOPULSE_AGENT_HOME` | `~/.gnopulse-agent` | Agent keybase and signer state |
| `GNOPULSE_SIGNER_ADDR` | allocated loopback port | Exclusive local signer address; an occupied fixed address is refused |
| `GNOTX_BIN` | bundled binary | Use your own `gnotx` build |
| `GNOTX_SERVICE_URL` | `http://127.0.0.1:8787` | Signing service URL (the launcher sets it) |
| `GNOTX_SERVICE_TOKEN` | | Signing service bearer token (the launcher sets it) |
| `GNOPULSE_MCP_TRANSPORT` | `stdio` | `http` for Streamable HTTP |
| `GNOPULSE_MCP_HOST` | `127.0.0.1` | HTTP listen host |
| `GNOPULSE_MCP_PORT` | `8080` | HTTP listen port |
| `GNOPULSE_MCP_REQUIRE_KEY` | | `1` rejects HTTP sessions without an API key |
| `GNOPULSE_MCP_TIMEOUT_MS` | `15000` | API and RPC request timeout |

Malformed numeric policy values stop the server with an error naming the variable.

To self-host the HTTP transport, set `GNOPULSE_MCP_TRANSPORT=http` (see the [`Dockerfile`](Dockerfile)). It serves read and simulate tools only and refuses to start with any signer configured.

## Development

```sh
npm ci
npm test            # unit tests
npm run test:e2e    # stdio and HTTP end-to-end tests against local mocks
```

`gnotx` is a Go module in [`gnotx/`](gnotx). See its [README](gnotx/README.md).

## Security

Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## License

The MCP server is [MIT](LICENSE). `gnotx` is licensed under the [GNO Network General Public License](gnotx/LICENSE) because it links gno.land packages, and runs as a separate process.

Built on [gno.land](https://gno.land).

## Testing on Onyx

Use a dedicated unfunded test wallet and explicitly set all three chain pointers before integration testing:

```sh
GNO_CHAIN_ID=onyx-1 \
GNO_RPC_URLS=https://rpc.onyx.testnets.gno.land \
GNOPULSE_API_BASE=https://gnopulse.xyz/onyx \
GNOPULSE_AGENT_HOME=/path/to/private/onyx-test-wallet \
npx -y @gnopulse/mcp
```

The API key must belong to the Onyx service. Verify `gno_status` and `gno_agent_status` report `onyx-1` before continuing. Funding and transaction broadcasts are separate actions requiring approval. HTTP exposes status and simulation but does not register execution, deployment, or confirmation tools.

## Data contracts

Bounded list tools (events, holders and pools) accept `offset`; results retain `limit`,
`offset`, `next_offset`, `total` and `has_more`. Cursor feeds continue to use `next_cursor`.
`gno_api_usage` performs one standard block-list read and returns that response's quota
headers. It consumes the normal request cost. List responses also include their own quota
headers. No usage is inferred from a separate session or client.

`gno_mev` returns same-pool, same-block sandwich-pattern candidates, not arbitrage or general
MEV detection. `gno_wash_trades` returns transaction-netted round-trip activity with evidence,
not proof of wash trading or common ownership. Both accept supported windows of 1, 7 and
30 days and an offset. These tools require the matching v2 API release and its rollups.
Application-level errors inside HTTP-200 responses are returned as MCP tool errors.

Set `GNOPULSE_SIGNER=none` for read-only local use: the launcher does not resolve a signer
binary, create a keybase, generate secrets or start a signer process. Hosted HTTP remains
read/simulate only. Transport sessions are not wallet authorization.

For an externally managed shared signer, run the built server directly (`node dist/index.js`)
with `GNOTX_SERVICE_URL` and `GNOTX_SERVICE_TOKEN`. Its lifetime belongs to your service
manager. The launcher owns isolated child signers and does not adopt preexisting processes.


Settled swap signals page with `gno_swap_signals` using the previous result's
`next_cursor` as `cursor`. Keep the same filters between pages. Offset remains a deprecated
compatibility option; do not combine it with a cursor. Cursor calls fail explicitly against
older APIs that do not return the cursor contract, rather than silently repeating page one.
Deploy the supporting API before updating MCP clients. Roll back affected MCP clients before
rolling an API back to a release without cursor support.
