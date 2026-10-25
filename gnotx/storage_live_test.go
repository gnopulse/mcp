package main

import (
	"os"
	"strings"
	"testing"

	"github.com/gnolang/gno/gno.land/pkg/gnoclient"
	"github.com/gnolang/gno/gno.land/pkg/sdk/vm"
	rpcclient "github.com/gnolang/gno/tm2/pkg/bft/rpc/client"
)

// Opt-in, public-RPC only. No signer, keybase or broadcast path is constructed.
func TestOnyxStorageCeiling(t *testing.T) {
	caller, recipient := os.Getenv("GNOTX_LIVE_ONYX_CALLER"), os.Getenv("GNOTX_LIVE_ONYX_RECIPIENT")
	if caller == "" || recipient == "" {
		t.Skip("set a funded Onyx wugnot holder and a new recipient for unsigned live verification")
	}
	rpc, err := rpcclient.NewHTTPClient("https://rpc.onyx.testnets.gno.land")
	if err != nil {
		t.Fatal(err)
	}
	cli := &gnoclient.Client{RPCClient: rpc}
	addr, err := bech32(caller)
	if err != nil {
		t.Fatal(err)
	}
	before, _, err := cli.QueryAccount(addr)
	if err != nil {
		t.Fatal(err)
	}
	msg := vm.MsgCall{Caller: addr, PkgPath: "gno.land/r/gnoland/wugnot", Func: "Transfer", Args: []string{recipient, "1"}}
	cfg := &config{chainID: "onyx-1", gasFee: "auto"}
	preview, _, err := simulateUnsigned(cli, cfg, caller, "Transfer", msg, nil)
	if err != nil || !preview.OK {
		t.Fatalf("preview: %#v %v", preview, err)
	}
	if preview.Extra["estimated_storage_deposit_ugnot"] == "0" {
		t.Fatal("recipient must be new so storage grows")
	}
	t.Logf("unsigned live storage preview: %+v", preview.Extra)
	cfg.maxStorageDepositUgnot = 1
	blocked, _, err := simulateUnsigned(cli, cfg, caller, "Transfer", msg, nil)
	if err != nil {
		t.Fatal(err)
	}
	if blocked.OK || !strings.Contains(blocked.Log, "deposit") {
		t.Fatalf("chain did not reject one-ugnot ceiling: %#v", blocked)
	}
	after, _, err := cli.QueryAccount(addr)
	if err != nil {
		t.Fatal(err)
	}
	if before.Sequence != after.Sequence || before.Coins.String() != after.Coins.String() {
		t.Fatal("account changed during unsigned checks")
	}
	t.Log("chain rejected inadequate storage ceiling; wallet sequence and native balance unchanged; no signer exists")
}
