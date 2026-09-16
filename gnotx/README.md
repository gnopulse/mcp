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

With `-gas-fee auto`, the fee is `gas_wanted * price / 1000` ugnot, where
`price` is `GNOTX_GAS_PRICE_MILLI` (default `13`), with a minimum of
`100000ugnot`.

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
