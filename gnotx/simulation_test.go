package main

import (
	"bytes"
	"context"
	"fmt"
	"strconv"
	"strings"
	"testing"

	"github.com/gnolang/gno/gno.land/pkg/gnoclient"
	"github.com/gnolang/gno/gno.land/pkg/gnoland"
	"github.com/gnolang/gno/gno.land/pkg/sdk/vm"
	"github.com/gnolang/gno/gnovm/stdlibs/chain"
	"github.com/gnolang/gno/tm2/pkg/amino"
	abci "github.com/gnolang/gno/tm2/pkg/bft/abci/types"
	rpcclient "github.com/gnolang/gno/tm2/pkg/bft/rpc/client"
	ctypes "github.com/gnolang/gno/tm2/pkg/bft/rpc/core/types"
	"github.com/gnolang/gno/tm2/pkg/crypto"
	"github.com/gnolang/gno/tm2/pkg/crypto/keys"
	"github.com/gnolang/gno/tm2/pkg/crypto/secp256k1"
	"github.com/gnolang/gno/tm2/pkg/std"
)

type simulationRPC struct {
	rpcclient.Client
	t           *testing.T
	pub         crypto.PubKey
	fail        bool
	simulations int
	deposits    []int64
	gasBySize   bool
}

func (r *simulationRPC) Status(context.Context, *int64) (*ctypes.ResultStatus, error) {
	out := &ctypes.ResultStatus{}
	out.NodeInfo.Network = "onyx-1"
	return out, nil
}
func (r *simulationRPC) ABCIQuery(_ context.Context, path string, data []byte) (*ctypes.ResultABCIQuery, error) {
	out := &ctypes.ResultABCIQuery{}
	if strings.HasPrefix(path, "auth/accounts/") {
		out.Response.Data = amino.MustMarshalJSON(gnoland.GnoAccount{BaseAccount: std.BaseAccount{Address: r.pub.Address(), PubKey: r.pub, AccountNumber: 7, Sequence: 4}})
		return out, nil
	}
	if path != ".app/simulate" {
		return nil, fmt.Errorf("unexpected query %s", path)
	}
	r.simulations++
	var tx std.Tx
	if err := amino.Unmarshal(data, &tx); err != nil {
		r.t.Fatal(err)
	}
	if len(tx.Signatures) != 1 || !bytes.Equal(tx.Signatures[0].Signature, make([]byte, 64)) {
		r.t.Fatal("simulation carried a real signature")
	}
	if tx.Signatures[0].PubKey.Address() != r.pub.Address() {
		r.t.Fatal("wrong caller public key")
	}
	result := abci.ResponseDeliverTx{GasUsed: 10000}
	if r.gasBySize {
		// The chain charges gas per transaction byte.
		result.GasUsed += int64(len(data)) * 10
	}
	if len(r.deposits) > 0 {
		i := r.simulations - 1
		if i >= len(r.deposits) {
			i = len(r.deposits) - 1
		}
		deposit := r.deposits[i]
		if deposit != 0 {
			result.Events = []abci.Event{chain.StorageDepositEvent{BytesDelta: deposit / 100, FeeDelta: std.Coin{Denom: "ugnot", Amount: deposit}, PkgPath: "gno.land/r/demo/x"}}
		}
	}
	if r.fail {
		result.Error = abci.StringError("deliberate realm failure")
		result.Log = "denied"
	}
	out.Response.Value = amino.MustMarshal(result)
	return out, nil
}

type publicInfo struct {
	keys.Info
	pub crypto.PubKey
}

func (i publicInfo) GetPubKey() crypto.PubKey   { return i.pub }
func (i publicInfo) GetAddress() crypto.Address { return i.pub.Address() }

type countingSigner struct {
	gnoclient.Signer
	pub   crypto.PubKey
	signs int
	tx    *std.Tx
}

func (s *countingSigner) Info() (keys.Info, error)  { return publicInfo{pub: s.pub}, nil }
func (s *countingSigner) GetMaster() crypto.Address { return crypto.Address{} }
func (s *countingSigner) Sign(c gnoclient.SignCfg) (*std.Tx, error) {
	s.signs++
	s.tx = &c.UnsignedTX
	return &c.UnsignedTX, nil
}

func TestSimulationNeverSigns(t *testing.T) {
	for _, tc := range []struct {
		name            string
		broadcast, fail bool
		signs           int
	}{{"preview", false, false, 0}, {"failed execution", true, true, 0}, {"authorized execution", true, false, 1}} {
		t.Run(tc.name, func(t *testing.T) {
			pub := secp256k1.GenPrivKey().PubKey()
			rpc := &simulationRPC{t: t, pub: pub, fail: tc.fail}
			signer := &countingSigner{pub: pub}
			cli := &gnoclient.Client{Signer: signer, RPCClient: rpc}
			c := &config{chainID: "onyx-1", gasFee: defGasFee}
			c.broadcast = tc.broadcast
			msg := vm.MsgCall{Caller: pub.Address(), PkgPath: "gno.land/r/demo/x", Func: "Ping"}
			_, _, result, failed, err := prepareCall(cli, c, pub.Address().String(), "Ping", msg, nil)
			if err != nil {
				t.Fatal(err)
			}
			if failed != tc.fail || result.OK == tc.fail {
				t.Fatal("wrong simulation outcome")
			}
			if signer.signs != tc.signs {
				t.Fatalf("signed %d times, expected %d", signer.signs, tc.signs)
			}
			if rpc.simulations < 1 {
				t.Fatal("no simulation before signing")
			}
		})
	}
}
func TestKeylessSimulationAndCallerBinding(t *testing.T) {
	pub := secp256k1.GenPrivKey().PubKey()
	rpc := &simulationRPC{t: t, pub: pub}
	cli := &gnoclient.Client{RPCClient: rpc}
	msg := vm.MsgCall{Caller: pub.Address(), PkgPath: "gno.land/r/demo/x", Func: "Ping"}
	if _, _, err := simulateUnsigned(cli, &config{chainID: "onyx-1", gasFee: defGasFee}, pub.Address().String(), "Ping", msg, nil); err != nil {
		t.Fatal(err)
	}
	if _, _, err := simulateUnsigned(cli, &config{chainID: "onyx-1", gasFee: defGasFee}, pub.Address().String(), "Ping", msg, secp256k1.GenPrivKey().PubKey()); err == nil {
		t.Fatal("accepted different wallet public key")
	}
}

func TestLoadingWalletDoesNotValidateBySigning(t *testing.T) {
	home := t.TempDir()
	kb, err := keysFromDir(home)
	if err != nil {
		t.Fatal(err)
	}
	mnemonic := "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
	info, err := kb.CreateAccount("agent", mnemonic, "", "correct-password", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	// An incorrect password can read public metadata, but cannot produce a signature.
	signer, addr, err := buildSigner(&config{home: home, key: "agent", password: "wrong-password", chainID: "onyx-1"})
	if err != nil || addr != info.GetAddress().String() {
		t.Fatalf("public metadata unexpectedly signed: %v", err)
	}
	if _, err := signer.Info(); err != nil {
		t.Fatal(err)
	}
}

func TestApprovedBoundsStopSigning(t *testing.T) {
	for _, limits := range []struct{ gas, fee int64 }{{1, 0}, {0, 1}} {
		pub := secp256k1.GenPrivKey().PubKey()
		rpc := &simulationRPC{t: t, pub: pub}
		signer := &countingSigner{pub: pub}
		cli := &gnoclient.Client{Signer: signer, RPCClient: rpc}
		c := &config{chainID: "onyx-1", gasFee: defGasFee, broadcast: true, maxGasWanted: limits.gas, maxFeeUgnot: limits.fee}
		msg := vm.MsgCall{Caller: pub.Address(), PkgPath: "gno.land/r/demo/x", Func: "Ping"}
		if _, _, _, _, err := prepareCall(cli, c, pub.Address().String(), "Ping", msg, nil); err == nil {
			t.Fatal("exceeded approved bounds")
		}
		if signer.signs != 0 {
			t.Fatal("signed before approved fee/gas limits were checked")
		}
	}
}

func TestStoragePreviewAndSignedCeiling(t *testing.T) {
	for _, deposit := range []int64{0, 206100} {
		t.Run(fmt.Sprint(deposit), func(t *testing.T) {
			pub := secp256k1.GenPrivKey().PubKey()
			rpc := &simulationRPC{t: t, pub: pub, deposits: []int64{deposit}}
			signer := &countingSigner{pub: pub}
			cli := &gnoclient.Client{Signer: signer, RPCClient: rpc}
			c := &config{chainID: "onyx-1", gasFee: defGasFee, broadcast: true}
			msg := vm.MsgCall{Caller: pub.Address(), PkgPath: "gno.land/r/demo/x", Func: "Ping"}
			tx, _, r, _, err := prepareCall(cli, c, pub.Address().String(), "Ping", msg, nil)
			if err != nil {
				t.Fatal(err)
			}
			limit := deposit
			if limit == 0 {
				limit = 1
			}
			if r.Extra["estimated_storage_deposit_ugnot"] != fmt.Sprint(deposit) || r.Extra["estimated_total_fee_ugnot"] != fmt.Sprint(100000+limit) {
				t.Fatal(r.Extra)
			}
			if tx.Msgs[0].(vm.MsgCall).MaxDeposit.AmountOf("ugnot") != limit {
				t.Fatal("signed storage ceiling missing")
			}
		})
	}
}

func TestStorageGrowthAndCombinedCostNeverSign(t *testing.T) {
	for _, tc := range []struct {
		name         string
		deposits     []int64
		fee, storage int64
	}{
		{"fee plus storage", []int64{206100}, 260000, 206100},
		{"growth after estimate", []int64{206100, 206200}, 500000, 206100},
		{"growth after zero estimate", []int64{0, 100}, 500000, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pub := secp256k1.GenPrivKey().PubKey()
			rpc := &simulationRPC{t: t, pub: pub, deposits: tc.deposits}
			signer := &countingSigner{pub: pub}
			cli := &gnoclient.Client{Signer: signer, RPCClient: rpc}
			c := &config{chainID: "onyx-1", gasFee: defGasFee, broadcast: true, maxGasWanted: 20000000, maxFeeUgnot: tc.fee, maxStorageDepositUgnot: tc.storage}
			msg := vm.MsgCall{Caller: pub.Address(), PkgPath: "gno.land/r/demo/x", Func: "Ping"}
			if _, _, _, _, err := prepareCall(cli, c, pub.Address().String(), "Ping", msg, nil); err == nil {
				t.Fatal("cost change was not rejected")
			}
			if signer.signs != 0 {
				t.Fatal("signed beyond approved total or storage ceiling")
			}
		})
	}
}

func TestApprovedPreviewSignsAtItsOwnGasLimit(t *testing.T) {
	pub := secp256k1.GenPrivKey().PubKey()
	msg := vm.MsgCall{Caller: pub.Address(), PkgPath: "gno.land/r/demo/x", Func: "Ping"}
	preview := &gnoclient.Client{RPCClient: &simulationRPC{t: t, pub: pub, deposits: []int64{206100}, gasBySize: true}}
	r, _, err := simulateUnsigned(preview, &config{chainID: "onyx-1", gasFee: "auto"}, pub.Address().String(), "Ping", msg, pub)
	if err != nil {
		t.Fatal(err)
	}
	fee, _ := strconv.ParseInt(r.Extra["estimated_total_fee_ugnot"], 10, 64)
	storage, _ := strconv.ParseInt(r.Extra["storage_deposit_limit_ugnot"], 10, 64)

	signer := &countingSigner{pub: pub}
	cli := &gnoclient.Client{Signer: signer, RPCClient: &simulationRPC{t: t, pub: pub, deposits: []int64{206100}, gasBySize: true}}
	c := &config{chainID: "onyx-1", gasFee: "auto", broadcast: true, maxGasWanted: r.GasWanted, maxFeeUgnot: fee, maxStorageDepositUgnot: storage}
	if _, _, _, _, err := prepareCall(cli, c, pub.Address().String(), "Ping", msg, nil); err != nil {
		t.Fatal(err)
	}
	if signer.signs != 1 || signer.tx.Fee.GasWanted != r.GasWanted {
		t.Fatalf("signed %d times at gas %d, approved %d", signer.signs, signer.tx.Fee.GasWanted, r.GasWanted)
	}
}

type pricedRPC struct {
	*simulationRPC
	price string
}

func (r *pricedRPC) ABCIQuery(ctx context.Context, path string, data []byte) (*ctypes.ResultABCIQuery, error) {
	if path == "auth/gasprice" {
		out := &ctypes.ResultABCIQuery{}
		out.Response.Data = []byte(`{"gas":"1000","price":"` + r.price + `"}`)
		return out, nil
	}
	return r.simulationRPC.ABCIQuery(ctx, path, data)
}

func TestAutoFeeFollowsTheChainGasPrice(t *testing.T) {
	pub := secp256k1.GenPrivKey().PubKey()
	msg := vm.MsgCall{Caller: pub.Address(), PkgPath: "gno.land/r/demo/x", Func: "Ping"}
	cli := &gnoclient.Client{RPCClient: &pricedRPC{&simulationRPC{t: t, pub: pub}, "1ugnot"}}
	c := &config{chainID: "onyx-1", gasFee: "auto", gasWanted: 200_000_000}
	r, _, err := simulateUnsigned(cli, c, pub.Address().String(), "Ping", msg, pub)
	if err != nil {
		t.Fatal(err)
	}
	// 200M gas at 1 ugnot per 1000 gas, plus the 20% margin.
	if r.Extra["estimated_fee_ugnot"] != "240000" {
		t.Fatalf("fee %s", r.Extra["estimated_fee_ugnot"])
	}
}
