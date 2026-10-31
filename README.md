# GnoPulse MCP

[![ci](https://github.com/gnopulse/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/gnopulse/mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@gnopulse/mcp)](https://www.npmjs.com/package/@gnopulse/mcp)

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents read, analyze and transact on [gno.land](https://gno.land).

- **Chain and analytics tools**: chain reads, wallets, tokens, NFTs, pools, and on-chain analytics from [GnoPulse](https://gnopulse.xyz).
- **Local signing**: keys stay in `gnotx`, a local signer process. The model and the MCP server never see them.
- **Signing disabled by default**: agent identity, service execution permission and an explicit signer mode are separate from API access. Interactive mode requires trusted client approval.

## Quick start

### Hosted: read and analyze

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

The hosted server holds no wallet keys. HTTP never registers execution or confirmation tools. Simulation is advertised only when an explicitly configured healthy backend declares unsigned simulation support. A listed tool can still become unavailable during a later outage; failures never fall back to signing.

### Let your agent act on-chain

The agent gets its own small wallet on your computer. What it may do is chosen in the server's settings when your app starts it; no tool call can change that.

| Mode | `GNOPULSE_SIGNER` | What happens |
|---|---|---|
| Data only (default) | `none` | Reads and simulations. Nothing is signed. |
| Approve each transaction | `user-approval` | The agent proposes; you approve each one in a system window on your computer or in your app's approval form. |
| Autonomous | `microservice` | The agent acts without asking, inside limits you set: which realms and functions, how much per transaction, and until when. |

1. Add one of these to your app's MCP settings (Claude Code, Codex, Cursor, VS Code, Claude Desktop):

   ```json
   { "mcpServers": { "gnopulse": {
     "command": "npx", "args": ["-y", "@gnopulse/mcp"],
     "env": {
       "GNOPULSE_API_KEY": "YOUR_KEY",
       "GNOPULSE_AGENT_ID": "my-agent",
       "GNOPULSE_SIGNER": "user-approval" } } } }
   ```

   For autonomous mode, use `"GNOPULSE_SIGNER": "microservice"` and add limits, for example:

   ```json
       "GNOPULSE_POLICY_ALLOW_REALMS": "gno.land/r/gnoland/wugnot,gno.land/r/gnoswap/router",
       "GNOPULSE_POLICY_ALLOW_FUNCS": "Deposit,Withdraw,Approve,ExactInSwapRoute",
       "GNOPULSE_POLICY_MAX_SEND_UGNOT": "1000000",
       "GNOPULSE_POLICY_MAX_FEE_UGNOT": "3000000",
       "GNOPULSE_POLICY_MAX_GAS": "300000000",
       "GNOPULSE_POLICY_EXPIRES_IN": "86400"
   ```

   Autonomous mode will not start without all six; the error names any that are missing.
2. Restart the app and ask the agent for its wallet. `gno_agent_status` reports the address, the balance, what it may do, and how you approve.
3. Send it GNOT. Treat it like a prepaid card: fund only what you are willing to lose. A first GnoSwap swap also locks about 2 GNOT as a storage deposit.
4. Ask it to act. If something is outside your limits, the agent is told not to work around it but to ask you, naming the setting that would allow it. To allow more, change that setting (or ask the agent to) and restart the app.

Things to know:

- Limits apply to the GnoPulse tools. An agent with unrestricted shell access on your computer could read the wallet key in `~/.gnopulse-agent`, so keep your app's own approval for file edits and shell commands on when an agent wallet is funded.
- Limits are per transaction, not daily budgets, and the send cap covers GNOT only, not GRC20 tokens. Allowing `Approve` or a token transfer function grants what those calls permit.
- Web chat apps (claude.ai, ChatGPT) can only use the hosted server, which reads data and cannot sign. Claude's chat apps may decline to make transactions even with signing on; Claude Code does not.
- OpenAI models see at most 128 tools, so run one GnoPulse server at a time in ChatGPT or Codex.

### Local setup details

Use matching MCP and native binary versions; do not mix them with an older signing backend.

With no agent ID, the default launcher runs data tools without creating a wallet. To create a persistent wallet for one agent, configure:

```json
{
  "mcpServers": {
    "developer": {
      "command": "npx",
      "args": ["-y", "@gnopulse/mcp"],
      "env": {
        "GNOPULSE_API_KEY": "YOUR_KEY",
        "GNOPULSE_AGENT_ID": "developer",
        "GNOPULSE_SIGNER": "none"
      }
    }
  }
}
```

Give every logical agent a distinct lowercase `GNOPULSE_AGENT_ID`. Its keybase is stored under `~/.gnopulse-agent/agents/<chain>/<agent-id>` (or the same suffix beneath `GNOPULSE_AGENT_HOME`). An agent ID reuses its wallet on restart; different IDs and chains have separate wallets. API keys authenticate data access and do not grant wallet execution authority. Do not reuse another agent's ID or copy its keybase.

The launcher starts its own authenticated loopback service with execution disabled. A named agent can inspect its address and simulate ordinary realm calls using public key metadata, without signing. Without an ID and with signing disabled, no keybase or service is created. Funding a wallet does not enable execution.

The owner can explicitly select `GNOPULSE_SIGNER=user-approval`. Proposals return an unsigned preview and single-use token. `gno_confirm` asks the person in this order: a native approval window on this computer (macOS, Windows, or Linux with zenity or kdialog), then the client's MCP elicitation form, or an authenticated host approval when one is attached. The window works in any client, including ones too old to show forms; set `GNOPULSE_APPROVAL_DIALOG=off` to skip it. With no way to ask (no desktop, as over SSH, and a client without forms), `gno_agent_status` and the proposal itself say so, naming the client and how to update it, and no token is issued. The client chooses the presentation, such as an in-chat confirmation or approval card. A token or model-supplied tool argument is insufficient. Cancellation, refusal and expiry fail closed. An agent with unrestricted shell access and macOS Accessibility permission could in principle drive the approval window, so do not grant those to an agent you do not trust. Elicitation waits only until the proposal expires and follows tool-call cancellation; an expired, cancelled or failed approval cannot be revived by a late response. Clients must present these requests to the human, not automatically accept them.

The launcher uses the bundled native binary, isolates service ports, and stops its own child service on exit. An occupied configured port is refused. Legacy `~/.gnopulse-agent` keys are not moved, deleted or silently reused: back them up and explicitly plan migration before funding a new agent address.

Examples for ElizaOS, LangChain, the OpenAI Agents SDK and the Vercel AI SDK are in [`adapters/`](adapters).

## How execution works

```
agent ──▶ gno_call / gno_swap / gno_approve
            │  simulate + policy check
            ▼
          preview + approval token      (nothing broadcast)
            │  client requests human consent
            ▼
          gno_confirm ──▶ consent accepted + policy rechecked
                           └─▶ gnotx re-simulates unsigned, then signs and broadcasts
```

Set `GNOPULSE_SIGNER=microservice` to execute without per-transaction confirmation. This is an explicit standing execution grant. Startup requires both realm and function allowlists, explicit native-send, fee and gas caps, and a future expiry. `GNOPULSE_SIGNER=tee` uses the same grant rules with an external signer. `EXPIRES_IN` is relative to startup; use `EXPIRES_AT` for a fixed cutoff across restarts. These are per-transaction bounds, not cumulative budgets; native-send caps do not restrict GRC20 token amounts. Allowing a token transfer or approval function grants whatever token authority that call and its arguments permit.

### Client-native human confirmation

MCP does not provide a universal proof that a user said yes in chat. A trusted host integration can turn authenticated user confirmation into a transaction-bound Ed25519 authorization. Set `GNOPULSE_APPROVAL_PUBLIC_KEY_FILE` to the host authorization public-key PEM. Keep the matching private key in the host's separate secret store, outside model tools, prompts and the agent wallet. This is an authorization key, not the blockchain wallet key.

An interactive proposal includes `approval_challenge` when a host key is configured. The host presents the exact challenge intent and simulation to its user, obtains consent through its own interface, then uses `signClientApproval` and attaches the receipt to the `gno_confirm` request's `_meta["io.gnopulse/approval"]`. The server checks the configured key, wallet, chain, agent, transaction, preview digest, gas/fee bounds, token and expiry. Receipts are single-use. Invalid supplied receipts never fall back to another approval method. See [`adapters/trusted-client-approval.mjs`](adapters/trusted-client-approval.mjs).

Without a signed receipt, a client supporting MCP form elicitation can collect approval using that standard mechanism. Its presentation need not be a separate form. Unsupported clients refuse execution. A native tool-approval event from another platform is not automatically a receipt: the trusted host adapter must connect it to this challenge. Codex can use native MCP elicitation directly; see `adapters/codex.toml`. Custom host receipt adapters are optional. This package does not configure ChatGPT or Claude approval integrations, and hosted HTTP still exposes no execution tools.

The host must not sign receipts based on the model claiming approval or expose its signing helper as an agent tool. Either approval path trusts the host to obtain real consent. To revoke a configured host authorization key, remove or replace its public-key configuration and restart the local MCP process; pending proposals are in memory and do not survive restart.

## Tools

| Area | Tools |
|---|---|
| Chain | `gno_status` `gno_blocks` `gno_get_block` `gno_get_transactions` `gno_get_events` `gno_get_account` `gno_get_balances` `gno_eval` `gno_render` `gno_get_package` `gno_package_files` `gno_search` `gno_health` `gno_sparklines` |
| Explorer | `gno_realms` `gno_functions` `gno_failed_calls` `gno_realm_graph` `gno_discoveries` `gno_libraries` `gno_library` `gno_gpao_queue` `gno_gpao_package` |
| Governance and bridges | `gno_governance` `gno_governance_votes` `gno_validators` `gno_bridges` `gno_bridge_transfers` `gno_wraps` |
| Tokens | `gno_token_registry` `gno_token_metadata` `gno_token_balance` `gno_token_holders` `gno_holder_series` `gno_prices` `gno_price_list` `gno_ohlcv` `gno_token_directory` `gno_launchpad` `gno_launch_quote` |
| Wallets | `gno_wallet_tokens` `gno_wallet_transfers` `gno_wallet_pnl` `gno_wallet_defi` `gno_wallet_realms` `gno_wallet_cluster` `gno_label` `gno_whales` |
| NFTs | `gno_grc721` `gno_nft_holdings` `gno_nft_collection` |
| DEX | `gno_pools` `gno_pool_depth` `gno_pool_lp_providers` `gno_pool_ohlcv` `gno_pool_trades` `gno_dex_analytics` `gno_dex_series` `gno_swap_hops` `gno_dex_route` `gno_dex_quote` |
| Analytics | `gno_smart_money` `gno_swap_signals` `gno_launch_radar` `gno_launch_snipers` `gno_mev` `gno_wash_trades` `gno_dev_activity` `gno_cvd` `gno_wallet_flows` `gno_known_entities` |
| Execution | `gno_agent_status` `gno_simulate`; with a signer configured, also `gno_call` `gno_swap` `gno_approve` `gno_deploy` `gno_confirm` |

Data and analytics tools call the GnoPulse API with `GNOPULSE_API_KEY`.

`gno_nft_holdings` accepts `address`, optional `limit` (1 to 1000, default 500), and
optional `cursor`. Pass the returned `next_cursor` until it is null. `total` and
`by_collection` cover the whole owner's holdings, not the loaded page. Ownership
can change between requests. The tool requires an API with NFT cursor support and
reports an incompatibility instead of silently repeating page one on an older API.

## Configuration

Data access needs no wallet configuration. Execution requires an explicit agent identity, wallet address and enabled signing service. The launcher supplies the wallet address after reading public metadata.

| Variable | Default | |
|---|---|---|
| `GNOPULSE_API_KEY` | | GnoPulse API key |
| `GNOPULSE_API_BASE` | `https://gnopulse.xyz` | GnoPulse API base URL |
| `GNO_RPC_URLS` | public gnoland-1 RPCs | Comma-separated RPC endpoints, tried in order |
| `GNO_CHAIN_ID` | `gnoland-1` | Also passed to the signer by the launcher |
| `GNO_GRC20_REGISTRY` | `gno.land/r/nt/grc20reg/v0` | GRC20 registry realm |
| `GNOPULSE_SIGNER` | `none` | `user-approval`, `microservice`, `tee`, or `none` (reads and simulation only; write tools are not listed) |
| `GNOPULSE_POLICY_MAX_SEND_UGNOT` | `5000000` with `npx`, else none | Maximum native ugnot sent per transaction. Does not cover GRC20 approve or swap amounts |
| `GNOPULSE_POLICY_ALLOW_REALMS` | | Only these realms (comma-separated) |
| `GNOPULSE_POLICY_DENY_REALMS` | | Never these realms |
| `GNOPULSE_POLICY_ALLOW_FUNCS` | | Only these functions (comma-separated) |
| `GNOPULSE_POLICY_DENY_FUNCS` | | Never these functions |
| `GNOPULSE_POLICY_DEFAULT` | `allow` | `deny` rejects every call when no allow rule is set |
| `GNOPULSE_POLICY_FEES_ONLY` | | `1` denies any non-zero native send. Like the cap above, it does not cover a GRC20 transfer, which is a call with an empty send |
| `GNOPULSE_APPROVAL_PUBLIC_KEY_FILE` | | Trusted host Ed25519 authorization public-key PEM file |
| `GNOPULSE_POLICY_MAX_FEE_UGNOT` | | Maximum gas plus storage ceiling per transaction (refunds excluded) |
| `GNOPULSE_POLICY_MAX_GAS` | | Maximum simulated gas per transaction |
| `GNOPULSE_POLICY_EXPIRES_IN` / `_AT` | | Session expiry in seconds, or a unix time |
| `GNOPULSE_AGENT_ID` | none | Required for a wallet; unique lowercase ID per logical agent |
| `GNOPULSE_AGENT_ADDRESS` | launcher sets it | Expected service wallet, required when running an execution server directly |
| `GNOPULSE_AGENT_HOME` | `~/.gnopulse-agent` | Root for `agents/<chain>/<agent-id>` keybases |
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

To self-host the HTTP transport, set `GNOPULSE_MCP_TRANSPORT=http` (see the [`Dockerfile`](Dockerfile)). It refuses every configured execution signer. To add simulation, explicitly configure a matching unsigned-only `gnotx serve -caller <public-address>` backend. This mode holds no keys and accepts a caller per request; it cannot enable execution. Hosted simulation requires a caller address and, before its first on-chain transaction, its compressed public key. Only ordinary MsgCall previews are supported; read-only/non-crossing functions should use qeval. Code-bearing deployment/run messages can require signatures and are not supported by this unsigned hosted preview.

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
GNOPULSE_AGENT_ID=onyx-developer \
GNOPULSE_SIGNER=none \
npx -y @gnopulse/mcp
```

The API key must belong to the Onyx service. Verify `gno_status` and `gno_agent_status` report `onyx-1` before continuing. Funding and transaction broadcasts are separate actions requiring approval. HTTP exposes status and, only with a verified backend, unsigned simulation. Execution, deployment and confirmation tools are absent.

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

For data-only local use, omit `GNOPULSE_AGENT_ID` and set `GNOPULSE_SIGNER=none`: no binary, keybase, secrets or child service is needed. With an ID, the same signing-disabled setting creates that agent's wallet and starts an execution-disabled unsigned preview service.

For an externally managed **per-agent** signing service, explicitly run `gnotx serve -allow-execute` with a private bearer token. Run `node dist/index.js` with the matching `GNOPULSE_AGENT_ID`, `GNOPULSE_AGENT_ADDRESS`, service URL/token and signer mode. Never share a signing identity between unrelated agents or attach a production settlement key to hosted MCP. Its lifetime belongs to your service manager.

The trusted local operator controls configuration and keybase access. These controls isolate MCP tool authority, not hostile processes with the same operating-system account, a compromised client that forges consent, or an extracted private key. Policies are local configuration, not on-chain signed delegation grants. Cumulative token budgets and delegated session accounts remain separate capabilities.


Settled swap signals page with `gno_swap_signals` using the previous result's
`next_cursor` as `cursor`. Keep the same filters between pages. Offset remains a deprecated
compatibility option; do not combine it with a cursor. Cursor calls fail explicitly against
older APIs that do not return the cursor contract, rather than silently repeating page one.
Deploy the supporting API before updating MCP clients. Roll back affected MCP clients before
rolling an API back to a release without cursor support.


Wallet status and funding instructions use the configured agent address and chain after verifying the backend identity. A mismatch is an error, with no funding instructions. An unavailable balance is not reported as an empty wallet. Unconfigured data-only and hosted clients do not adopt the service's default caller as an agent wallet.

Swap policies check the concrete `gno.land/r/gnoswap/router.ExactInSwapRoute` call. The same target, arguments and fixed deadline are used for preview, consent and execution; metadata cannot substitute a different policy target.

### Transaction review and storage limits

Human approval shows a deterministic plain-language summary before technical details: action, network, agent wallet, amount sent, gas fee ceiling, estimated storage deposit, authorized storage ceiling, estimated refund and maximum native debit. Known swap/allowance/wrapped-GNOT intents have specific descriptions. Unknown realm functions show their exact target and ordered arguments with effects explicitly undecoded; token decimals and contract outcomes are never invented. The native client's Accept button submits the form. The separate signing checkbox must also be checked; it remains false by default.

Unsigned previews retain `estimated_fee_ugnot` as the gas component and add `estimated_storage_deposit_ugnot`, `storage_deposit_limit_ugnot`, `estimated_storage_refund_ugnot` and `estimated_total_fee_ugnot`. The last field is gas plus the authorized storage ceiling, without subtracting refunds. `GNOPULSE_POLICY_MAX_FEE_UGNOT` bounds that combined amount; the separately configured native send cap still applies. These limits do not cap GRC20 movements or every possible contract effect.

The proposal binds total fee, gas and storage ceilings. `/execute` requires `max_gas_wanted`, `max_fee_ugnot` (gas plus storage) and `max_storage_deposit_ugnot` together. The signing service re-simulates, rejects cost growth beyond consent, and writes the approved storage ceiling into the signed MsgCall.MaxDeposit. On-chain enforcement protects against storage growth after the final simulation; a rejected transaction can still consume its authorized gas fee. A zero MaxDeposit invokes the chain default, so a zero-storage estimate reserves and discloses one ugnot instead. Missing, malformed, inconsistent or overflowing cost estimates cannot authorize signing. Gas-only older backends must be upgraded with the MCP client.

Hosted chain/simulation tools require a successful usage-authorization response before execution. Timeouts, network failures, malformed allowances and explicit denials stop the tool. Local stdio public-RPC reads preserve their no-key and metering-outage behavior; an intentionally keyless hosted deployment must set its key requirement off explicitly.

Token-holder distribution tools retain the complete REST distribution bundle in `items`, including `holders`, summary metrics and `partial`. Page with the outer `has_more` and `next_offset` using the tool offset parameter. `total` is the API-reported holder_count, not the current page length; the retained partial flag still describes source completeness. Launch radar and LP-provider tools also retain their summary bundles in items and are not generic array pages. Use token_path values from the registry/prices feed, including the qualified token name (for example a realm.Token identifier), rather than assuming a bare realm identifies one token.


### Coordinated accounting and data candidate

The unpublished candidate adds hosted reserve/finish accounting with a service credential kept only by operators. Customer API keys cannot attest tool completion. REST wrappers are charged by REST once; local public-RPC tools remain independent of hosted credits. Upgrade the API and hosted service together before enabling the new accounting epoch. Failed or refused tools release reservations; a committed result does not prove network delivery to the client.

The matching API serves holder pages from worker projections with raw integer amounts and observation ages. Read `freshness`, `partial` and per-holder `balance_observed_at`; balances are observations at different times, not a census at one current block. Missing or stale required projections return explicit errors. LP contribution estimates retain unpriced events and distinguish historical contributors from separately verified current position owners. Follow the cursor returned for events and offset for contributor bundles. These changes require the matching API producers and readers before a package rollout.

The versioned `capabilities.json` describes registered tools and their transports. REST has additional routes without dedicated MCP wrappers. Token registry, balance and metadata reads distinguish provider failure from verified empty data. Onyx has no GnoSwap trading analytics; its test-only payment configuration is not a market exchange rate.

For the LP tool, outer `has_more` and `next_cursor` describe event history; send the cursor as `before`. Contributor paging is independent: use `contributors_has_more` and `next_offset` with `offset`. The `items` bundle retains both source flags. A completed contributor page does not imply that all events were fetched.
