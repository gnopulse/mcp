package main

import (
	"github.com/gnolang/gno/gnovm/stdlibs/chain"
	abci "github.com/gnolang/gno/tm2/pkg/bft/abci/types"
	"github.com/gnolang/gno/tm2/pkg/std"
	"math"
	"testing"
)

func TestStorageGrossCosts(t *testing.T) {
	events := []abci.Event{
		chain.StorageDepositEvent{FeeDelta: std.Coin{Denom: "ugnot", Amount: 206100}},
		chain.StorageDepositEvent{FeeDelta: std.Coin{Denom: "ugnot", Amount: 100}},
		chain.StorageUnlockEvent{FeeRefund: std.Coin{Denom: "ugnot", Amount: 900000}},
		chain.StorageUnlockEvent{FeeRefund: std.Coin{Denom: "ugnot", Amount: 500}, RefundWithheld: true},
	}
	d, r, e := storageCosts(events)
	if e != nil || d != 206200 || r != 900000 {
		t.Fatalf("%d %d %v", d, r, e)
	}
	d, r, e = storageCosts(nil)
	if e != nil || d != 0 || r != 0 {
		t.Fatal("empty event costs")
	}
	for _, coin := range []std.Coin{{Denom: "other", Amount: 1}, {Denom: "ugnot", Amount: -1}} {
		if _, _, err := storageCosts([]abci.Event{chain.StorageDepositEvent{FeeDelta: coin}}); err == nil {
			t.Fatal("invalid storage amount accepted")
		}
	}
	if _, _, err := storageCosts([]abci.Event{chain.StorageDepositEvent{FeeDelta: std.Coin{Denom: "ugnot", Amount: math.MaxInt64}}, chain.StorageDepositEvent{FeeDelta: std.Coin{Denom: "ugnot", Amount: 1}}}); err == nil {
		t.Fatal("overflow accepted")
	}
}
func TestExecuteRequiresCompleteLimits(t *testing.T) {
	valid := callReq{MaxGasWanted: 100, MaxFeeUgnot: "1001", MaxStorageDepositUgnot: "1"}
	if err := applyExecutionBounds(&config{}, valid); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []callReq{{}, {MaxGasWanted: 100, MaxFeeUgnot: "1001"}, {MaxGasWanted: 100, MaxFeeUgnot: "1", MaxStorageDepositUgnot: "1"}, {MaxGasWanted: 100, MaxFeeUgnot: "1001", MaxStorageDepositUgnot: "-1"}} {
		if err := applyExecutionBounds(&config{}, invalid); err == nil {
			t.Fatal("incomplete limits accepted")
		}
	}
}
