// Command gnotx signs and broadcasts gno.land transactions using gnoclient.
//
// The call, swap, approve and addpkg commands simulate first and broadcast only
// when -broadcast is passed. serve exposes POST /simulate, which never
// broadcasts, and POST /execute, which broadcasts after a successful simulation.
// Output is JSON on stdout; errors are printed as {"error": "..."} with exit
// status 1.
//
// Examples:
//
//	gnotx account -key mykey
//	gnotx swap -key mykey -in gno.land/r/gnoland/wugnot -out gno.land/r/gnoswap/gns \
//	     -amount-in 10000000 -min-out 1
//	gnotx approve -key mykey -token gno.land/r/gnoswap/gns -spender <addr> -amount 1000000 -broadcast
package main

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gnolang/gno/gno.land/pkg/gnoclient"
	"github.com/gnolang/gno/gno.land/pkg/sdk/vm"
	"github.com/gnolang/gno/tm2/pkg/amino"
	rpcclient "github.com/gnolang/gno/tm2/pkg/bft/rpc/client"
	"github.com/gnolang/gno/tm2/pkg/crypto"
	"github.com/gnolang/gno/tm2/pkg/crypto/bip39"
	"github.com/gnolang/gno/tm2/pkg/crypto/keys"
	_ "github.com/gnolang/gno/tm2/pkg/sdk/bank" // registers /bank.MsgSend for amino decoding in verify
	"github.com/gnolang/gno/tm2/pkg/std"
)

// Defaults target gnoland-1 mainnet; override them with flags or environment variables.
const (
	defRemote  = "https://rpc.onbloc.xyz"
	defChainID = "gnoland-1"
	defGasFee  = "100000ugnot"
	routerPath = "gno.land/r/gnoswap/router"

	// minFeeUgnot is the smallest fee gnotx will attach to a transaction.
	minFeeUgnot = 100000
	// probeGasWanted is the gas ceiling for the estimation simulation.
	probeGasWanted = 500_000_000
	// defGasPriceMilli is the default gas price for -gas-fee=auto, in milli-ugnot per gas unit.
	defGasPriceMilli = 13
)

// defHome returns the keybase directory: GNOTX_HOME, then GNOHOME, then
// gnokey's default of the user config directory joined with "gno".
func defHome() string {
	if h := os.Getenv("GNOTX_HOME"); h != "" {
		return h
	}
	if h := os.Getenv("GNOHOME"); h != "" {
		return h
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "gno")
}

// config carries the chain/key/gas settings shared by every subcommand.
type config struct {
	remote, chainID, home, key, password string
	gasFee                               string
	gasWanted                            int64
	memo                                 string
	broadcast                            bool
}

func (c *config) bind(fs *flag.FlagSet) {
	fs.StringVar(&c.remote, "remote", env("GNOTX_REMOTE", defRemote), "chain RPC endpoint")
	fs.StringVar(&c.chainID, "chainid", env("GNOTX_CHAINID", defChainID), "chain id for signing")
	fs.StringVar(&c.home, "home", defHome(), "gnokey keybase directory (holds keys.db)")
	fs.StringVar(&c.key, "key", os.Getenv("GNOTX_KEY"), "key name or bech32 address in the keybase (required to sign)")
	fs.StringVar(&c.password, "password", os.Getenv("GNOTX_PASSWORD"), "keybase password (or set GNOTX_PASSWORD)")
	fs.StringVar(&c.gasFee, "gas-fee", env("GNOTX_GAS_FEE", defGasFee), "gas fee coin, e.g. 1000000ugnot")
	fs.Int64Var(&c.gasWanted, "gas-wanted", 0, "gas wanted; 0 = auto-estimate from a simulation (+30%)")
	fs.StringVar(&c.memo, "memo", "", "transaction memo")
	fs.BoolVar(&c.broadcast, "broadcast", false, "actually broadcast; without it, simulate only")
}

// isAutoFee reports whether the gas fee should be derived from the gas estimate.
func isAutoFee(gasFee string) bool { return gasFee == "" || gasFee == "auto" }

// probeFee returns the fee coin used for the estimation simulation. Simulations
// are never charged, so with an auto fee a small valid coin is enough.
func probeFee(gasFee string) string {
	if isAutoFee(gasFee) {
		return fmt.Sprintf("%dugnot", minFeeUgnot)
	}
	return gasFee
}

// feeFor returns the fee coin for a broadcast at gasWanted. An explicit -gas-fee
// is used as is; with -gas-fee=auto the fee is gasWanted times the gas price
// (GNOTX_GAS_PRICE_MILLI, milli-ugnot per gas), floored at minFeeUgnot.
func (c *config) feeFor(gasWanted int64) string {
	if !isAutoFee(c.gasFee) {
		return c.gasFee
	}
	price := int64(defGasPriceMilli)
	if v := os.Getenv("GNOTX_GAS_PRICE_MILLI"); v != "" {
		if p, err := strconv.ParseInt(v, 10, 64); err == nil && p > 0 {
			price = p
		}
	}
	fee := gasWanted * price / 1000
	if fee < minFeeUgnot {
		fee = minFeeUgnot
	}
	return fmt.Sprintf("%dugnot", fee)
}

// withHeadroom returns the gas to request for a transaction that used gasUsed in simulation.
func withHeadroom(gasUsed int64) int64 { return gasUsed * 13 / 10 }

// env returns the value of the environment variable k, or def when it is unset or empty.
func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// result is the JSON envelope printed for every command.
type result struct {
	Mode      string            `json:"mode"`           // "simulate", "broadcast" or "query"
	Caller    string            `json:"caller"`         // signer address
	Func      string            `json:"func,omitempty"` // pkgpath.func acted on
	GasUsed   int64             `json:"gas_used,omitempty"`
	GasWanted int64             `json:"gas_wanted,omitempty"`
	OK        bool              `json:"ok"`                // simulated or broadcast tx succeeded
	Log       string            `json:"log,omitempty"`     // node log on failure
	ReturnVal []string          `json:"return,omitempty"`  // decoded function return values
	TxHash    string            `json:"tx_hash,omitempty"` // broadcast only
	Height    int64             `json:"height,omitempty"`  // broadcast only
	Extra     map[string]string `json:"extra,omitempty"`   // command-specific details
}

const commands = "account|call|swap|approve|realmaddr|addpkg|serve|verify|keygen"

func main() {
	if len(os.Args) < 2 {
		fail("usage: gnotx <%s> [flags]", commands)
	}
	var err error
	switch os.Args[1] {
	case "account":
		err = cmdAccount(os.Args[2:])
	case "call":
		err = cmdCall(os.Args[2:])
	case "swap":
		err = cmdSwap(os.Args[2:])
	case "approve":
		err = cmdApprove(os.Args[2:])
	case "realmaddr":
		err = cmdRealmAddr(os.Args[2:])
	case "addpkg":
		err = cmdAddpkg(os.Args[2:])
	case "serve":
		err = cmdServe(os.Args[2:])
	case "verify":
		err = cmdVerify(os.Args[2:])
	case "keygen":
		err = cmdKeygen(os.Args[2:])
	case "-h", "--help", "help":
		fmt.Printf("gnotx <%s> [flags]; -h on a subcommand for its flags\n", commands)
		return
	default:
		fail("unknown command %q (%s)", os.Args[1], commands)
	}
	if err != nil {
		fail("%v", err)
	}
}

// fail prints a JSON error envelope and exits with status 1.
func fail(format string, a ...any) {
	out, _ := json.Marshal(map[string]string{"error": fmt.Sprintf(format, a...)})
	fmt.Println(string(out))
	os.Exit(1)
}

// emit prints v as indented JSON.
func emit(v any) {
	out, _ := json.MarshalIndent(v, "", "  ")
	fmt.Println(string(out))
}

func keysFromDir(dir string) (keys.Keybase, error) { return keys.NewKeyBaseFromDir(dir) }

// cmdKeygen creates a key in the keybase, or reports the existing one when -key
// is already present, so an existing address is never replaced. It prints
// {name, address, created} and, on creation with -show-mnemonic, the mnemonic.
func cmdKeygen(args []string) error {
	fs := flag.NewFlagSet("keygen", flag.ExitOnError)
	var home, key, password string
	var showMnemonic bool
	fs.StringVar(&home, "home", defHome(), "keybase directory (holds keys.db)")
	fs.StringVar(&key, "key", env("GNOTX_KEY", "gpagent"), "key name to create/reuse")
	fs.StringVar(&password, "password", os.Getenv("GNOTX_PASSWORD"), "keybase password (or set GNOTX_PASSWORD)")
	fs.BoolVar(&showMnemonic, "show-mnemonic", false, "print the mnemonic on first creation (recovery)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if home == "" {
		return fmt.Errorf("keygen needs -home (no user config directory found)")
	}
	if password == "" {
		return fmt.Errorf("keygen needs a keybase password (set GNOTX_PASSWORD or -password)")
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return fmt.Errorf("create home %q: %w", home, err)
	}
	kb, err := keysFromDir(home)
	if err != nil {
		return fmt.Errorf("open keybase at %q: %w", home, err)
	}

	out := map[string]string{"name": key}
	if has, herr := kb.HasByName(key); herr != nil {
		return fmt.Errorf("check key %q: %w", key, herr)
	} else if has {
		info, gerr := kb.GetByName(key)
		if gerr != nil {
			return fmt.Errorf("load key %q: %w", key, gerr)
		}
		out["address"] = info.GetAddress().String()
		out["created"] = "false"
		emit(out)
		return nil
	}

	entropy, err := bip39.NewEntropy(256)
	if err != nil {
		return fmt.Errorf("entropy: %w", err)
	}
	mnemonic, err := bip39.NewMnemonic(entropy)
	if err != nil {
		return fmt.Errorf("mnemonic: %w", err)
	}
	info, err := kb.CreateAccount(key, mnemonic, "", password, 0, 0)
	if err != nil {
		return fmt.Errorf("create key %q: %w", key, err)
	}
	out["address"] = info.GetAddress().String()
	out["created"] = "true"
	if showMnemonic {
		out["mnemonic"] = mnemonic
	}
	emit(out)
	return nil
}

func bech32(s string) (crypto.Address, error) { return crypto.AddressFromBech32(s) }

// buildSigner opens the keybase and validates the key, returning the signer and
// its address. The signer is independent of the RPC endpoint, so serve shares
// one signer across all mirrors.
func buildSigner(c *config) (gnoclient.SignerFromKeybase, string, error) {
	if c.key == "" {
		return gnoclient.SignerFromKeybase{}, "", fmt.Errorf("-key is required (key name or address, or set GNOTX_KEY)")
	}
	if c.home == "" {
		return gnoclient.SignerFromKeybase{}, "", fmt.Errorf("-home is required (no user config directory found)")
	}
	kb, err := keysFromDir(c.home)
	if err != nil {
		return gnoclient.SignerFromKeybase{}, "", fmt.Errorf("open keybase at %q: %w", c.home, err)
	}
	signer := gnoclient.SignerFromKeybase{
		Keybase:  kb,
		Account:  c.key,
		Password: c.password,
		ChainID:  c.chainID,
	}
	if err := signer.Validate(); err != nil {
		return signer, "", fmt.Errorf("signer: %w (is key %q in the keybase, chainid set?)", err, c.key)
	}
	info, err := signer.Info()
	if err != nil {
		return signer, "", fmt.Errorf("key info: %w", err)
	}
	return signer, info.GetAddress().String(), nil
}

// newClient returns a keybase-backed client for c.remote and the signer address.
func newClient(c *config) (*gnoclient.Client, string, error) {
	signer, addr, err := buildSigner(c)
	if err != nil {
		return nil, "", err
	}
	rpc, err := rpcclient.NewHTTPClient(c.remote)
	if err != nil {
		return nil, "", fmt.Errorf("rpc client: %w", err)
	}
	return &gnoclient.Client{Signer: signer, RPCClient: rpc}, addr, nil
}

// cmdAccount prints the signer's account number, sequence and balance.
func cmdAccount(args []string) error {
	fs := flag.NewFlagSet("account", flag.ExitOnError)
	c := &config{}
	c.bind(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}

	cli, addr, err := newClient(c)
	if err != nil {
		return err
	}
	info, err := cli.Signer.Info()
	if err != nil {
		return err
	}
	acct, _, err := cli.QueryAccount(info.GetAddress())
	if err != nil {
		return fmt.Errorf("query account (unfunded/unknown on chain?): %w", err)
	}
	bal, _ := cli.Query(gnoclient.QueryCfg{Path: "bank/balances/" + addr})
	balance := ""
	if bal != nil {
		balance = string(bal.Response.Data)
	}
	emit(&result{
		Mode:   "query",
		Caller: addr,
		OK:     true,
		Extra: map[string]string{
			"account_number": fmt.Sprint(acct.AccountNumber),
			"sequence":       fmt.Sprint(acct.Sequence),
			"balance":        balance,
		},
	})
	return nil
}

// cmdCall runs a MsgCall against any realm function.
func cmdCall(args []string) error {
	fs := flag.NewFlagSet("call", flag.ExitOnError)
	c := &config{}
	c.bind(fs)
	pkgPath := fs.String("pkgpath", "", "realm/package path to call, e.g. gno.land/r/gnoswap/router")
	fn := fs.String("func", "", "exported function name to call")
	send := fs.String("send", "", "coins to send with the call, e.g. 1000000ugnot")
	var callArgs multiFlag
	fs.Var(&callArgs, "arg", "a positional argument (repeatable, in order)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if *pkgPath == "" || *fn == "" {
		return fmt.Errorf("call requires -pkgpath and -func")
	}
	cli, addr, err := newClient(c)
	if err != nil {
		return err
	}
	msg, err := mkMsg(addr, *pkgPath, *fn, []string(callArgs), *send)
	if err != nil {
		return err
	}
	return runMsg(cli, c, addr, *pkgPath+"."+*fn, msg)
}

// cmdSwap swaps an exact input amount through the GnoSwap router.
func cmdSwap(args []string) error {
	fs := flag.NewFlagSet("swap", flag.ExitOnError)
	c := &config{}
	c.bind(fs)
	in := fs.String("in", "", "input token path")
	out := fs.String("out", "", "output token path")
	amountIn := fs.String("amount-in", "", "exact input amount (raw integer units)")
	minOut := fs.String("min-out", "1", "minimum acceptable output (slippage floor, raw units)")
	route := fs.String("route", "", "route string in:out:feeTier; defaults to a single-hop -in:-out:-fee")
	fee := fs.String("fee", "500", "single-hop fee tier when -route is omitted (e.g. 100/500/3000/10000)")
	quote := fs.String("quote", "100", "percent split across routes (comma-separated; single route = 100)")
	deadline := fs.Int64("deadline", 120, "seconds from now until the swap expires")
	referrer := fs.String("referrer", "", "referrer address (optional)")
	send := fs.String("send", "", "coins to send (only for native ugnot input wrapping)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if *in == "" || *out == "" || *amountIn == "" {
		return fmt.Errorf("swap requires -in, -out, -amount-in")
	}
	r := *route
	if r == "" {
		r = fmt.Sprintf("%s:%s:%s", *in, *out, *fee)
	}
	dl := fmt.Sprint(time.Now().Add(time.Duration(*deadline) * time.Second).Unix())

	cli, addr, err := newClient(c)
	if err != nil {
		return err
	}
	// router.ExactInSwapRoute(inputToken, outputToken, amountIn, routeArr,
	// quoteArr, amountOutMin, deadline, referrer); the realm argument is implicit.
	callArgs := []string{*in, *out, *amountIn, r, *quote, *minOut, dl, *referrer}
	msg, err := mkMsg(addr, routerPath, "ExactInSwapRoute", callArgs, *send)
	if err != nil {
		return err
	}
	return runMsg(cli, c, addr, routerPath+".ExactInSwapRoute", msg)
}

// cmdApprove sets a GRC20 allowance for a spender.
func cmdApprove(args []string) error {
	fs := flag.NewFlagSet("approve", flag.ExitOnError)
	c := &config{}
	c.bind(fs)
	token := fs.String("token", "", "grc20 token realm path to approve")
	spender := fs.String("spender", "", "address allowed to spend (e.g. the router/pool address)")
	amount := fs.String("amount", "", "allowance amount (raw units); use a large value for unlimited")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if *token == "" || *spender == "" || *amount == "" {
		return fmt.Errorf("approve requires -token, -spender, -amount")
	}
	cli, addr, err := newClient(c)
	if err != nil {
		return err
	}
	msg, err := mkMsg(addr, *token, "Approve", []string{*spender, *amount}, "")
	if err != nil {
		return err
	}
	return runMsg(cli, c, addr, *token+".Approve", msg)
}

// cmdRealmAddr prints the on-chain address of each package path, for example
// the spender to approve before a swap.
func cmdRealmAddr(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: gnotx realmaddr <pkgpath> [pkgpath...]")
	}
	out := map[string]string{}
	for _, p := range args {
		out[p] = crypto.AddressFromPreimage([]byte("pkgPath:" + p)).String()
	}
	emit(out)
	return nil
}

var pkgNameRe = regexp.MustCompile(`(?m)^package\s+(\w+)`)

// readMemPackage loads a directory's .gno files into a MemPackage. The package
// name is taken from the `package` clause of the first non-test file.
func readMemPackage(dir, path string) (*std.MemPackage, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var files []*std.MemFile
	name := ""
	hasGnomod := false
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		isGno := strings.HasSuffix(e.Name(), ".gno")
		if !isGno && e.Name() != "gnomod.toml" {
			continue
		}
		body, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		files = append(files, &std.MemFile{Name: e.Name(), Body: string(body)})
		if e.Name() == "gnomod.toml" {
			hasGnomod = true
		}
		if isGno && name == "" && !strings.HasSuffix(e.Name(), "_test.gno") {
			if m := pkgNameRe.FindStringSubmatch(string(body)); m != nil {
				name = m[1]
			}
		}
	}
	if name == "" {
		name = path[strings.LastIndex(path, "/")+1:]
	}
	if len(files) == 0 || (len(files) == 1 && hasGnomod) {
		return nil, fmt.Errorf("no .gno files in %q", dir)
	}
	// The chain requires gnomod.toml; synthesize one as `gnokey maketx addpkg` does.
	if !hasGnomod {
		files = append(files, &std.MemFile{
			Name: "gnomod.toml",
			Body: fmt.Sprintf("module = %q\ngno = \"0.9\"\n", path),
		})
	}
	// MemPackage validation requires files sorted by name.
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	return &std.MemPackage{Name: name, Path: path, Files: files}, nil
}

// cmdAddpkg deploys a package with MsgAddPackage. Chain-side deploy policies
// (such as a CLA requirement or namespace ownership) surface as a failed
// simulation, in which case -broadcast refuses to send.
func cmdAddpkg(args []string) error {
	fs := flag.NewFlagSet("addpkg", flag.ExitOnError)
	c := &config{}
	c.bind(fs)
	pkgPath := fs.String("pkgpath", "", "deploy path, e.g. gno.land/r/<addr>/foo")
	pkgDir := fs.String("pkgdir", "", "local directory of .gno files")
	send := fs.String("send", "", "coins to send with the deploy")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if *pkgPath == "" || *pkgDir == "" {
		return fmt.Errorf("addpkg requires -pkgpath and -pkgdir")
	}
	cli, addr, err := newClient(c)
	if err != nil {
		return err
	}
	mempkg, err := readMemPackage(*pkgDir, *pkgPath)
	if err != nil {
		return err
	}
	creator, err := bech32(addr)
	if err != nil {
		return err
	}
	var coins std.Coins
	if strings.TrimSpace(*send) != "" {
		if coins, err = std.ParseCoins(*send); err != nil {
			return fmt.Errorf("parse -send %q: %w", *send, err)
		}
	}
	msg := vm.MsgAddPackage{Creator: creator, Package: mempkg, Send: coins}
	return runAddpkg(cli, c, addr, msg)
}

// runAddpkg simulates then (with -broadcast) deploys a MsgAddPackage.
func runAddpkg(cli *gnoclient.Client, c *config, addr string, msg vm.MsgAddPackage) error {
	info, err := cli.Signer.Info()
	if err != nil {
		return err
	}
	acct, _, err := cli.QueryAccount(info.GetAddress())
	if err != nil {
		return fmt.Errorf("query account (funded? CLA signed?): %w", err)
	}
	gasWanted := c.gasWanted
	probe := gasWanted
	if probe <= 0 {
		probe = probeGasWanted
	}
	base := gnoclient.BaseTxCfg{GasFee: probeFee(c.gasFee), GasWanted: probe, Memo: c.memo,
		AccountNumber: acct.AccountNumber, SequenceNumber: acct.Sequence}
	sign := func(b gnoclient.BaseTxCfg) (*std.Tx, error) {
		tx, terr := gnoclient.NewAddPackageTx(b, msg)
		if terr != nil {
			return nil, terr
		}
		return cli.SignTx(*tx, acct.AccountNumber, acct.Sequence)
	}

	signed, err := sign(base)
	if err != nil {
		return fmt.Errorf("sign: %w", err)
	}
	sim, err := cli.Simulate(signed)
	if err != nil {
		return fmt.Errorf("simulate: %w", err)
	}
	r := &result{Caller: addr, Func: "addpkg " + msg.Package.Path, GasUsed: sim.GasUsed}
	simFailed := sim.Error != nil
	if simFailed {
		r.Log = strings.TrimSpace(sim.Log)
	}
	if gasWanted <= 0 {
		gasWanted = withHeadroom(sim.GasUsed)
	}
	r.GasWanted = gasWanted

	if !c.broadcast {
		r.Mode = "simulate"
		r.OK = !simFailed
		emit(r)
		return nil
	}
	if simFailed {
		return fmt.Errorf("refusing to broadcast: simulation failed: %s", r.Log)
	}
	base.GasWanted = gasWanted
	base.GasFee = c.feeFor(gasWanted)
	signed, err = sign(base)
	if err != nil {
		return err
	}
	res, err := cli.BroadcastTxCommit(signed)
	if err != nil {
		return fmt.Errorf("broadcast: %w", err)
	}
	r.Mode = "broadcast"
	r.OK = true
	r.Height = res.Height
	r.TxHash = strings.ToUpper(hex.EncodeToString(res.Hash))
	emit(r)
	return nil
}

// callReq is the JSON body accepted by /simulate and /execute.
type callReq struct {
	Pkgpath string   `json:"pkgpath"`
	Func    string   `json:"func"`
	Args    []string `json:"args"`
	Send    string   `json:"send"`
}

// maxRequestBytes caps the body of a POST request to serve.
const maxRequestBytes = 1 << 20

// checkServeToken validates the serve authentication settings.
func checkServeToken(token string, insecureNoToken bool) error {
	if token == "" && !insecureNoToken {
		return fmt.Errorf("serve requires GNOTX_SERVE_TOKEN; pass -insecure-no-token to run without authentication")
	}
	return nil
}

// runFunc executes a validated request. remote, when set, is reported in the
// X-Gnotx-Remote header. code is the HTTP status to use when err is non-nil.
type runFunc func(req callReq, broadcast bool) (res *result, remote string, code int, err error)

// newServeMux returns the serve routes. An empty token disables authentication.
func newServeMux(token string, health func() map[string]any, run runFunc) *http.ServeMux {
	handle := func(broadcast bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if r.Method != http.MethodPost {
				writeErr(w, http.StatusMethodNotAllowed, "POST only")
				return
			}
			if !authorized(r, token) {
				writeErr(w, http.StatusUnauthorized, "missing/invalid bearer token")
				return
			}
			if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/json" {
				writeErr(w, http.StatusUnsupportedMediaType, "Content-Type must be application/json")
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
			var body callReq
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				var tooLarge *http.MaxBytesError
				if errors.As(err, &tooLarge) {
					writeErr(w, http.StatusRequestEntityTooLarge, "request body too large")
					return
				}
				writeErr(w, http.StatusBadRequest, "bad json: "+err.Error())
				return
			}
			if body.Pkgpath == "" || body.Func == "" {
				writeErr(w, http.StatusBadRequest, "pkgpath and func are required")
				return
			}
			res, remote, code, err := run(body, broadcast)
			if remote != "" {
				w.Header().Set("X-Gnotx-Remote", remote)
			}
			if err != nil {
				writeErr(w, code, err.Error())
				return
			}
			json.NewEncoder(w).Encode(res)
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(health())
	})
	mux.HandleFunc("/simulate", handle(false))
	mux.HandleFunc("/execute", handle(true))
	return mux
}

// authorized reports whether r carries "Authorization: Bearer <token>".
// An empty token accepts every request.
func authorized(r *http.Request, token string) bool {
	if token == "" {
		return true
	}
	got := []byte(r.Header.Get("Authorization"))
	want := []byte("Bearer " + token)
	return subtle.ConstantTimeCompare(got, want) == 1
}

// cmdServe runs an HTTP signing service. The key is loaded once at startup and
// never leaves the process. POST /simulate and /execute accept a callReq and
// return the same JSON envelope as the CLI; GET /healthz reports status. Both
// POST routes require "Authorization: Bearer <GNOTX_SERVE_TOKEN>" unless
// -insecure-no-token is set.
func cmdServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	c := &config{}
	c.bind(fs)
	fs.Lookup("broadcast").Usage = "deprecated and ignored: /simulate never broadcasts, /execute always does"
	addr := fs.String("addr", env("GNOTX_SERVE_ADDR", "127.0.0.1:8787"),
		"listen address; a non-loopback address exposes the signer to the network")
	remotesFlag := fs.String("remotes", env("GNOTX_REMOTES", ""),
		"comma-separated RPC mirrors for failover; overrides -remote when set")
	insecureNoToken := fs.Bool("insecure-no-token", false,
		"allow running without GNOTX_SERVE_TOKEN (no authentication)")
	if err := fs.Parse(args); err != nil {
		return err
	}

	token := os.Getenv("GNOTX_SERVE_TOKEN")
	if err := checkServeToken(token, *insecureNoToken); err != nil {
		return err
	}
	if token == "" {
		fmt.Fprintln(os.Stderr, "warning: gnotx serve is running without authentication (-insecure-no-token)")
	}

	remotes := parseRemotes(*remotesFlag, c.remote)

	// Sign with an external provider (GNOTX_TEE_PROVIDER) or the local keybase.
	var ext ExternalSigner
	var signer gnoclient.SignerFromKeybase
	var caller string
	var callerAddr crypto.Address
	backend := "keybase"
	if provider := os.Getenv("GNOTX_TEE_PROVIDER"); provider != "" {
		var err error
		if ext, err = buildExternalSigner(provider); err != nil {
			return err
		}
		callerAddr = ext.PubKey().Address()
		caller = callerAddr.String()
		backend = "tee:" + provider
	} else {
		var err error
		if signer, caller, err = buildSigner(c); err != nil {
			return err
		}
		if callerAddr, err = bech32(caller); err != nil {
			return fmt.Errorf("caller address: %w", err)
		}
	}

	clients := make([]*gnoclient.Client, len(remotes))
	for i, r := range remotes {
		rpc, err := rpcclient.NewHTTPClient(r)
		if err != nil {
			return fmt.Errorf("rpc client for %q: %w", r, err)
		}
		if ext != nil {
			clients[i] = &gnoclient.Client{RPCClient: rpc}
		} else {
			clients[i] = &gnoclient.Client{Signer: signer, RPCClient: rpc}
		}
	}

	// pick returns the first mirror, starting from the last healthy one, that
	// answers /health.
	var muPick sync.Mutex
	lastGood := 0
	pick := func() (*gnoclient.Client, string, bool) {
		muPick.Lock()
		start := lastGood
		muPick.Unlock()
		for k := 0; k < len(remotes); k++ {
			idx := (start + k) % len(remotes)
			if probeRemote(remotes[idx]) {
				muPick.Lock()
				lastGood = idx
				muPick.Unlock()
				return clients[idx], remotes[idx], true
			}
		}
		return nil, "", false
	}

	// Broadcasts are serialized because each consumes the account sequence.
	var broadcastMu sync.Mutex

	run := func(body callReq, broadcast bool) (*result, string, int, error) {
		msg, err := mkMsg(caller, body.Pkgpath, body.Func, body.Args, body.Send)
		if err != nil {
			return nil, "", http.StatusBadRequest, err
		}
		label := body.Pkgpath + "." + body.Func
		if broadcast {
			broadcastMu.Lock()
			defer broadcastMu.Unlock()
			res, err := serveExecute(clients, remotes, pick, c, caller, callerAddr, label, msg, ext)
			return res, "", http.StatusInternalServerError, err
		}
		cli, remote, ok := pick()
		if !ok {
			return nil, "", http.StatusServiceUnavailable, fmt.Errorf("no healthy RPC mirror among %v", remotes)
		}
		rc := *c
		rc.broadcast = false
		res, err := execMsg(cli, &rc, caller, label, msg, ext)
		return res, remote, http.StatusInternalServerError, err
	}

	health := func() map[string]any {
		_, remote, ok := pick()
		return map[string]any{
			"ok": ok, "caller": caller, "chainid": c.chainID,
			"remotes": remotes, "healthy_remote": remote,
		}
	}

	fmt.Fprintf(os.Stderr, "gnotx serve on %s caller=%s chain=%s backend=%s auth=%v mirrors=%v\n",
		*addr, caller, c.chainID, backend, token != "", remotes)
	srv := &http.Server{
		Addr:              *addr,
		Handler:           newServeMux(token, health, run),
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      130 * time.Second, // broadcasts wait for commit
	}
	return srv.ListenAndServe()
}

// parseRemotes returns the failover list: the comma-separated -remotes when set,
// otherwise the single -remote.
func parseRemotes(remotesCSV, single string) []string {
	if strings.TrimSpace(remotesCSV) == "" {
		return []string{single}
	}
	var out []string
	for _, r := range strings.Split(remotesCSV, ",") {
		if r = strings.TrimSpace(r); r != "" {
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		return []string{single}
	}
	return out
}

// probeRemote reports whether remote answers /health with 200 within two seconds.
func probeRemote(remote string) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(strings.TrimRight(remote, "/") + "/health")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// writeErr writes a JSON error body with the given status code.
func writeErr(w http.ResponseWriter, code int, msg string) {
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// serveExecute simulates and broadcasts msg with failover. If a broadcast
// returns a transport error, the outcome is resolved through the account
// sequence: a sequence past the signed one means the tx committed; otherwise
// the same signed bytes are retried on another mirror, which cannot apply twice
// because they carry the same sequence. If no mirror can be queried, the
// returned error reports the outcome as unknown.
func serveExecute(clients []*gnoclient.Client, remotes []string,
	pick func() (*gnoclient.Client, string, bool),
	c *config, addr string, callerAddr crypto.Address, label string, msg vm.MsgCall, ext ExternalSigner) (*result, error) {

	cli, remote, ok := pick()
	if !ok {
		return nil, fmt.Errorf("no healthy RPC mirror among %v", remotes)
	}
	signed, seq, r, simFailed, err := prepareCall(cli, c, addr, label, msg, ext)
	if err != nil {
		return nil, err
	}
	if simFailed {
		return nil, fmt.Errorf("refusing to broadcast: simulation failed: %s", r.Log)
	}

	attempts := len(clients) + 1
	for i := 0; i < attempts; i++ {
		res, berr := cli.BroadcastTxCommit(signed)
		if berr == nil {
			r.Mode = "broadcast"
			r.OK = true
			r.Height = res.Height
			r.TxHash = strings.ToUpper(hex.EncodeToString(res.Hash))
			r.ReturnVal = decodeReturn(res.DeliverTx.Data)
			r.Extra = map[string]string{"remote": remote}
			return r, nil
		}
		landed, decided := confirmLanded(clients, remotes, callerAddr, seq, 15*time.Second, 2*time.Second)
		if decided && landed {
			r.Mode = "broadcast"
			r.OK = true
			r.Log = "broadcast response lost, but confirmed committed via account sequence (hash/height unavailable)"
			r.Extra = map[string]string{"confirmed_by": "sequence"}
			return r, nil
		}
		if !decided {
			return nil, fmt.Errorf("broadcast to %s failed and on-chain state could not be confirmed "+
				"(tx may or may not have landed): %w", remote, berr)
		}
		// Not committed: retry the same signed tx on the next healthy mirror.
		next, nremote, ok2 := pick()
		if !ok2 {
			return nil, fmt.Errorf("tx not landed but no healthy mirror to retry: %w", berr)
		}
		cli, remote = next, nremote
	}
	return nil, fmt.Errorf("exhausted %d mirror attempts without a confirmed broadcast", attempts)
}

// currentSeq returns the account's on-chain sequence from the first healthy mirror.
func currentSeq(clients []*gnoclient.Client, remotes []string, addr crypto.Address) (uint64, bool) {
	for i, cli := range clients {
		if !probeRemote(remotes[i]) {
			continue
		}
		if acct, _, err := cli.QueryAccount(addr); err == nil {
			return acct.Sequence, true
		}
	}
	return 0, false
}

// confirmLanded polls the account sequence for up to grace to decide whether a
// tx signed at signedSeq committed. A sequence above signedSeq is conclusive
// because broadcasts from this process are serialized. decided is false only
// when no mirror could be queried.
func confirmLanded(clients []*gnoclient.Client, remotes []string, addr crypto.Address,
	signedSeq uint64, grace, poll time.Duration) (landed bool, decided bool) {
	deadline := time.Now().Add(grace)
	gotRead := false
	for {
		if seq, ok := currentSeq(clients, remotes, addr); ok {
			gotRead = true
			if seq > signedSeq {
				return true, true
			}
		}
		if !time.Now().Before(deadline) {
			if seq, ok := currentSeq(clients, remotes, addr); ok {
				return seq > signedSeq, true
			}
			return false, gotRead
		}
		time.Sleep(poll)
	}
}

// mkMsg builds a MsgCall from a bech32 caller and an optional coin string.
func mkMsg(caller, pkgPath, fn string, args []string, send string) (vm.MsgCall, error) {
	addr, err := bech32(caller)
	if err != nil {
		return vm.MsgCall{}, err
	}
	var coins std.Coins
	if strings.TrimSpace(send) != "" {
		coins, err = std.ParseCoins(send)
		if err != nil {
			return vm.MsgCall{}, fmt.Errorf("parse -send %q: %w", send, err)
		}
	}
	return vm.MsgCall{
		Caller:  addr,
		Send:    coins,
		PkgPath: pkgPath,
		Func:    fn,
		Args:    args,
	}, nil
}

// runMsg executes msg with the keybase signer and prints the result.
func runMsg(cli *gnoclient.Client, c *config, addr, label string, msg vm.MsgCall) error {
	r, err := execMsg(cli, c, addr, label, msg, nil)
	if err != nil {
		return err
	}
	emit(r)
	return nil
}

// prepareCall queries the account, simulates to estimate gas, and returns a
// broadcast-ready signed tx, the sequence it was signed at, and the simulation
// result. When ext is non-nil it signs with the external signer.
func prepareCall(cli *gnoclient.Client, c *config, addr, label string, msg vm.MsgCall, ext ExternalSigner) (
	signed *std.Tx, seq uint64, r *result, simFailed bool, err error) {
	var callerAddr crypto.Address
	if ext != nil {
		callerAddr = ext.PubKey().Address()
	} else {
		info, ierr := cli.Signer.Info()
		if ierr != nil {
			return nil, 0, nil, false, ierr
		}
		callerAddr = info.GetAddress()
	}
	acct, _, err := cli.QueryAccount(callerAddr)
	if err != nil {
		return nil, 0, nil, false, fmt.Errorf("query account (key funded on chain?): %w", err)
	}
	seq = acct.Sequence

	sign := func(gasWanted int64, gasFee string) (*std.Tx, error) {
		base := gnoclient.BaseTxCfg{GasFee: gasFee, GasWanted: gasWanted, Memo: c.memo,
			AccountNumber: acct.AccountNumber, SequenceNumber: acct.Sequence}
		tx, terr := gnoclient.NewCallTx(base, msg)
		if terr != nil {
			return nil, terr
		}
		if ext != nil {
			if serr := signTxExternal(tx, c.chainID, acct.AccountNumber, acct.Sequence, ext); serr != nil {
				return nil, serr
			}
			return tx, nil
		}
		s, serr := cli.SignTx(*tx, acct.AccountNumber, acct.Sequence)
		if serr != nil {
			return nil, fmt.Errorf("sign (wrong -password?): %w", serr)
		}
		return s, nil
	}

	probeGas := c.gasWanted
	if probeGas <= 0 {
		probeGas = probeGasWanted
	}
	s, err := sign(probeGas, probeFee(c.gasFee))
	if err != nil {
		return nil, seq, nil, false, err
	}
	sim, err := cli.Simulate(s)
	if err != nil {
		return nil, seq, nil, false, fmt.Errorf("simulate: %w", err)
	}

	r = &result{Caller: addr, Func: label, GasUsed: sim.GasUsed}
	simFailed = sim.Error != nil
	if simFailed {
		r.Log = strings.TrimSpace(sim.Log)
	}
	r.ReturnVal = decodeReturn(sim.Data)
	gasWanted := c.gasWanted
	if gasWanted <= 0 {
		gasWanted = withHeadroom(sim.GasUsed)
	}
	r.GasWanted = gasWanted

	// Re-sign with the estimated gas and its fee; this is the tx that gets broadcast.
	signed, err = sign(gasWanted, c.feeFor(gasWanted))
	if err != nil {
		return nil, seq, r, simFailed, err
	}
	return signed, seq, r, simFailed, nil
}

// execMsg simulates msg and, when c.broadcast is set, broadcasts it once.
func execMsg(cli *gnoclient.Client, c *config, addr, label string, msg vm.MsgCall, ext ExternalSigner) (*result, error) {
	signed, _, r, simFailed, err := prepareCall(cli, c, addr, label, msg, ext)
	if err != nil {
		return nil, err
	}
	if !c.broadcast {
		r.Mode = "simulate"
		r.OK = !simFailed
		return r, nil
	}
	if simFailed {
		return nil, fmt.Errorf("refusing to broadcast: simulation failed: %s", r.Log)
	}
	res, err := cli.BroadcastTxCommit(signed)
	if err != nil {
		return nil, fmt.Errorf("broadcast: %w", err)
	}
	r.Mode = "broadcast"
	r.OK = true
	r.Height = res.Height
	r.TxHash = strings.ToUpper(hex.EncodeToString(res.Hash))
	r.ReturnVal = decodeReturn(res.DeliverTx.Data)
	return r, nil
}

// decodeReturn splits the VM's "(value type)" return lines. Data that is only
// whitespace is returned base64-encoded so it is not dropped.
func decodeReturn(b []byte) []string {
	if len(b) == 0 {
		return nil
	}
	s := strings.TrimSpace(string(b))
	if s == "" {
		return []string{base64.StdEncoding.EncodeToString(b)}
	}
	return strings.Split(s, "\n")
}

// multiFlag collects a repeated -arg flag in order.
type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

// cmdVerify checks a Sign-In-With-Gno signature. The input is a base64,
// amino-encoded signed tx (as returned by Adena's SignTx) that is never
// broadcast. It needs no keybase or network: the caller supplies the account
// number and sequence used at signing time. It prints one line of JSON and exits
// 0 whether or not the signature is valid.
// verifySignature checks the first signature of tx against both sign payload renderings a wallet may
// produce: the amount/gas fee shape (Adena 1.21 and later, the Ledger Cosmos app) and the older
// gas_wanted/gas_fee shape.
func verifySignature(tx std.Tx, chainID string, accountNumber, sequence uint64) (std.PayloadRendering, error) {
	if len(tx.Signatures) == 0 || tx.Signatures[0].PubKey == nil {
		return std.PayloadRenderingNone, errors.New("tx carries no signature")
	}
	sig := tx.Signatures[0]
	rendering, err := std.VerifySignaturePayload(sig.PubKey, tx.SignDoc(chainID, accountNumber, sequence), sig.Signature)
	if err != nil {
		return std.PayloadRenderingNone, fmt.Errorf("build sign bytes: %w", err)
	}
	return rendering, nil
}

func renderingName(r std.PayloadRendering) string {
	switch r {
	case std.PayloadRenderingCurrent:
		return "current"
	case std.PayloadRenderingLegacy:
		return "legacy"
	default:
		return "none"
	}
}

func cmdVerify(args []string) error {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	encoded := fs.String("tx", "", "base64 encodedTransaction from adena.SignTx (required)")
	chainID := fs.String("chainid", defChainID, "chain id the tx was signed for")
	accountNumber := fs.Uint64("account", 0, "signer account_number at signing time (required)")
	sequence := fs.Uint64("sequence", 0, "signer sequence at signing time (required)")
	memoPrefix := fs.String("memo-prefix", "gnopulse-siwg:", "required memo prefix (the SIWG challenge)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *encoded == "" {
		return fmt.Errorf("verify: -tx (base64 encodedTransaction) is required")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(*encoded))
	if err != nil {
		return fmt.Errorf("verify: -tx is not valid base64: %w", err)
	}
	var tx std.Tx
	if err := amino.Unmarshal(raw, &tx); err != nil {
		return fmt.Errorf("verify: amino-decode tx: %w", err)
	}
	if len(tx.Signatures) == 0 || tx.Signatures[0].PubKey == nil {
		return fmt.Errorf("verify: tx carries no signature")
	}
	sig := tx.Signatures[0]
	rendering, err := verifySignature(tx, *chainID, *accountNumber, *sequence)
	if err != nil {
		return fmt.Errorf("verify: %w", err)
	}
	valid := rendering != std.PayloadRenderingNone
	memoOK := strings.HasPrefix(tx.Memo, *memoPrefix)

	out := map[string]any{
		"ok":              valid && memoOK,
		"signature_valid": valid,
		"payload":         renderingName(rendering),
		"address":         sig.PubKey.Address().String(),
		"memo":            tx.Memo,
		"memo_ok":         memoOK,
		"chain_id":        *chainID,
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
	return nil
}
