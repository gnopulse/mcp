# gnotx

`gnotx` is a command line tool and local signing service for gno.land. It
builds, simulates, signs and broadcasts transactions with the
[gnoclient](https://github.com/gnolang/gno/tree/master/gno.land/pkg/gnoclient)
library, using keys from a local gnokey keybase or an external signer.

It is the signing backend of the `@gnopulse/mcp` package, which ships prebuilt
binaries as `@gnopulse/gnotx-<os>-<arch>`.

## Build

Requires Go 1.25 or later.

```bash
go build -o gnotx .
```

## Output

Every command prints JSON to stdout. On error it prints `{"error": "..."}` and
exits with status 1. Transaction commands print:

```json
{
  "mode": "simulate",
  "caller": "g1...",
  "func": "gno.land/r/gnoland/wugnot.Deposit",
  "gas_used": 1234567,
  "gas_wanted": 1604937,
  "ok": true,
  "return": ["..."]
}
```

After a broadcast, `mode` is `broadcast` and `tx_hash` and `height` are set.

## Configuration

Flags shared by `account`, `call`, `swap`, `approve`, `addpkg` and `serve`:

| Flag | Environment | Default |
|---|---|---|
| `-remote` | `GNOTX_REMOTE` | `https://rpc.onbloc.xyz` |
| `-chainid` | `GNOTX_CHAINID` | `gnoland-1` |
| `-home` | `GNOTX_HOME`, then `GNOHOME` | gnokey's default (see below) |
| `-key` | `GNOTX_KEY` | none; required (key name or address) |
| `-password` | `GNOTX_PASSWORD` | empty |
| `-gas-fee` | `GNOTX_GAS_FEE` | `100000ugnot` |
| `-gas-wanted` | | `0` (estimate from simulation, plus 30%) |
| `-memo` | | empty |
| `-broadcast` | | `false` |

The default `-home` matches gnokey: the user config directory joined with
`gno`, which is `~/Library/Application Support/gno` on macOS, `~/.config/gno`
on Linux and `%AppData%\gno` on Windows.

With `-gas-fee auto`, the fee follows the chain's current minimum gas price
(`auth/gasprice`) plus 20%, since that price moves with demand. Set
`GNOTX_GAS_PRICE_MILLI` (milli-ugnot per gas) to override it. If the chain
price cannot be read, the price is `13`. The fee is at least `10000ugnot`.

An execution with an approved gas limit signs at exactly that limit, and is
refused if a fresh simulation uses more gas than it.

## Commands

### account

Prints the signer's address, account number, sequence and balance.

```bash
gnotx account -key mykey
```

### call

Calls an exported realm function. `-arg` is repeatable and positional.

```bash
gnotx call -key mykey -pkgpath gno.land/r/gnoland/wugnot -func Deposit -send 2000000ugnot -broadcast
```

### approve

Sets a GRC20 allowance.

```bash
gnotx approve -key mykey -token gno.land/r/gnoland/wugnot -spender g1... -amount 1000000 -broadcast
```

### swap

Swaps an exact input amount with `gno.land/r/gnoswap/router.ExactInSwapRoute`.
Without `-route`, the route is the single hop `in:out:fee`. `-min-out` is the
minimum output in raw units; `-deadline` is seconds from now.

```bash
gnotx swap -key mykey -in gno.land/r/gnoland/wugnot -out gno.land/r/gnoswap/gns \
  -amount-in 1000000 -fee 3000 -min-out 1
```

GnoSwap pulls the input token from the caller, so approve the router and pool
addresses for that token first. Native ugnot must be wrapped with
`wugnot.Deposit`.

### realmaddr

Prints the on-chain address of one or more package paths. No network access.

```bash
gnotx realmaddr gno.land/r/gnoswap/router gno.land/r/gnoswap/pool
```

### addpkg

Deploys the `.gno` files in a directory. A `gnomod.toml` is generated if the
directory does not contain one.

```bash
gnotx addpkg -key mykey -pkgpath gno.land/r/g1.../hello -pkgdir ./hello -broadcast
```

### keygen

Creates a key in the keybase, or reports the existing key if `-key` (default
`gpagent`) already exists. Requires a password. `-show-mnemonic` includes the
mnemonic in the output when a key is created.

```bash
GNOTX_PASSWORD=... gnotx keygen -key mykey
```

### verify

Verifies a Sign-In-With-Gno signature: a base64, amino-encoded signed
transaction (for example from Adena's `SignTx`) that is not broadcast. No
keybase or network access. Prints a single JSON line with `ok`,
`signature_valid`, `address`, `memo`, `memo_ok` and `chain_id`, and exits 0
whether or not the signature is valid.

```bash
gnotx verify -tx <base64> -account 12 -sequence 3 -memo-prefix gnopulse-siwg:
```

### serve

Runs a local HTTP signing service. The key is loaded once at startup.
`GNOTX_SERVE_TOKEN` is required: `serve` refuses to start without it unless
`-insecure-no-token` is passed, in which case it prints a warning and accepts
unauthenticated requests.

```bash
GNOTX_SERVE_TOKEN=secret gnotx serve -key mykey -addr 127.0.0.1:8787 \
  -remotes https://rpc-a.example,https://rpc-b.example
```

| Flag | Environment | Default |
|---|---|---|
| `-addr` | `GNOTX_SERVE_ADDR` | `127.0.0.1:8787`; a non-loopback address exposes the signer to the network |
| `-remotes` | `GNOTX_REMOTES` | the `-remote` value; comma-separated, overrides `-remote` |
| `-insecure-no-token` | | `false` |

`-broadcast` is accepted for compatibility but ignored: `/simulate` never
broadcasts and `/execute` always does after a successful simulation.

## HTTP API

| Route | Method | Description |
|---|---|---|
| `/healthz` | GET | `{ok, caller, chainid, remotes, healthy_remote}`; `caller` is the signer address. No token required. |
| `/simulate` | POST | Simulates a call. Sets `X-Gnotx-Remote` to the RPC used. |
| `/execute` | POST | Simulates, then broadcasts if the simulation succeeds. |

Request body for `/simulate` and `/execute`:

```json
{"pkgpath": "gno.land/r/gnoland/wugnot", "func": "Deposit", "args": [], "send": "1000000ugnot"}
```

`/simulate` and `/execute` require:

- `Authorization: Bearer <GNOTX_SERVE_TOKEN>`, otherwise 401.
- `Content-Type: application/json` (parameters such as `charset` are allowed),
  otherwise 415. This rejects cross-site form posts from browsers.
- A body of at most 1 MiB, otherwise 413.

Responses use the same JSON envelope as the CLI. Errors are `{"error": "..."}`
with status 400, 401, 405, 413, 415, 500 or 503.

Each request is routed to the first remote that answers `/health`. Broadcasts
are serialized. If a broadcast fails in transit, gnotx polls the account
sequence: if it advanced, the transaction is reported as committed; if not, the
same signed transaction is retried on another remote; if no remote can be
reached, an error reports the outcome as unknown.

### External signers

Set `GNOTX_TEE_PROVIDER` to sign with a key outside the keybase:

- `local`: derives the key from `GNOTX_TEE_MNEMONIC`. Intended for testing.
- `turnkey`: signs with [Turnkey](https://turnkey.com). Requires
  `TURNKEY_ORG_ID`, `TURNKEY_SIGN_WITH`, `TURNKEY_API_PRIVATE_KEY` (hex P-256)
  and `TURNKEY_PUBKEY` (hex compressed secp256k1); `TURNKEY_BASE_URL` is
  optional. This backend has not been verified against the live Turnkey API.

## Security

- Keys stay on the local machine (or with the external signer). gnotx sends
  only signed transactions to the RPC endpoint.
- CLI commands simulate by default and broadcast only with `-broadcast`.
  A failed simulation is never broadcast.
- `serve` `/execute` broadcasts without a `-broadcast` flag. Keep `-addr` on
  localhost and keep `GNOTX_SERVE_TOKEN` secret. Avoid `-insecure-no-token`.
- Prefer `GNOTX_PASSWORD` over `-password`, which is visible in the process
  list.

## License

GNO Network General Public License v6 (GNGPL). gnotx links gno.land packages
licensed under the GNGPL; see LICENSE.

Built on gno.land (https://gno.land).

## Unsigned previews and explicit execution permission

Ordinary `call`, `swap` and `approve` previews use public account metadata and an invalid placeholder signature. They do not call a signing function or broadcast. Before execution, the RPC network must match the configured chain, unsigned simulation must succeed, and the account sequence must remain unchanged. A final unsigned preview also validates the estimated fee. MCP execution carries the approved gas/fee ceilings, and a larger estimate is rejected before signing. The final transaction is signed only for an explicit CLI `-broadcast` or enabled service execution request. Public metadata loading does not sign a password-validation transaction.

`serve` defaults to execution disabled, even with a funded wallet. An owner must explicitly pass `-allow-execute` and configure a nonempty `GNOTX_SERVE_TOKEN` to permit `/execute`. The MCP additionally enforces its configured policy and client consent. Restrict this service to trusted local callers; its bearer credential authorizes the enabled execution endpoint.

For a keyless, shared simulation backend use `serve -caller <public-default-address> -chainid <chain> -remotes <rpc>`. This mode never opens a keybase and refuses `-allow-execute`. `/simulate` accepts `caller` and optional `public_key` (compressed secp256k1 hex). A public key must match the caller and is needed when the chain has no published key. Every response identifies `simulation_mode: unsigned`; rejection never triggers a signed fallback. Health reports `unsigned_simulation` and `execution_enabled` capabilities. Older signing simulators are intentionally incompatible with the repaired MCP preview path.

Unsigned preview is for ordinary realm calls. Non-crossing read functions use `vm/qeval`. Code-bearing `addpkg` uses the standalone deployment flow, may require a real signature during node simulation, and is not an unsigned MCP capability. Do not use deployment commands under a no-signing authorization.

Unsigned previews retain `estimated_fee_ugnot` as the gas component and add `estimated_storage_deposit_ugnot`, `storage_deposit_limit_ugnot`, `estimated_storage_refund_ugnot` and `estimated_total_fee_ugnot`. The last field is gas plus the authorized storage ceiling, without subtracting refunds. `GNOPULSE_POLICY_MAX_FEE_UGNOT` bounds that combined amount; the separately configured native send cap still applies. These limits do not cap GRC20 movements or every possible contract effect.

The proposal binds total fee, gas and storage ceilings. `/execute` requires `max_gas_wanted`, `max_fee_ugnot` (gas plus storage) and `max_storage_deposit_ugnot` together. The signing service re-simulates, rejects cost growth beyond consent, and writes the approved storage ceiling into the signed MsgCall.MaxDeposit. On-chain enforcement protects against storage growth after the final simulation; a rejected transaction can still consume its authorized gas fee. A zero MaxDeposit invokes the chain default, so a zero-storage estimate reserves and discloses one ugnot instead. Missing, malformed, inconsistent or overflowing cost estimates cannot authorize signing. Gas-only older backends must be upgraded with the MCP client.
