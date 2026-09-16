package main

// Sign-In-With-Gno messages are signed as transactions, and `gnotx verify`
// amino-decodes them, so every message type a wallet may sign must be
// registered for decoding.

import (
	"testing"

	"github.com/gnolang/gno/gno.land/pkg/sdk/vm"
	"github.com/gnolang/gno/tm2/pkg/amino"
	"github.com/gnolang/gno/tm2/pkg/crypto"
	"github.com/gnolang/gno/tm2/pkg/sdk/bank"
	"github.com/gnolang/gno/tm2/pkg/std"
)

func roundTrip(t *testing.T, msg std.Msg, memo string) std.Tx {
	t.Helper()
	tx := std.Tx{Msgs: []std.Msg{msg}, Memo: memo}
	raw, err := amino.Marshal(tx)
	if err != nil {
		t.Fatalf("amino.Marshal(%T): %v", msg, err)
	}
	var got std.Tx
	if err := amino.Unmarshal(raw, &got); err != nil {
		t.Fatalf("amino.Unmarshal(%T): %v (message type not registered)", msg, err)
	}
	if got.Memo != memo {
		t.Fatalf("memo round-trip: got %q want %q", got.Memo, memo)
	}
	if len(got.Msgs) != 1 {
		t.Fatalf("msgs round-trip: got %d want 1", len(got.Msgs))
	}
	return got
}

func TestSIWGDecodesBankMsgSend(t *testing.T) {
	var addr crypto.Address
	msg := bank.MsgSend{FromAddress: addr, ToAddress: addr}
	got := roundTrip(t, msg, "gnopulse-siwg:abc123")
	if got.Msgs[0].Route() != "bank" {
		t.Fatalf("route: got %q want %q", got.Msgs[0].Route(), "bank")
	}
}

func TestSIWGDecodesVMMsgCall(t *testing.T) {
	var addr crypto.Address
	msg := vm.MsgCall{Caller: addr, PkgPath: "gno.land/r/demo/users", Func: "Render", Args: []string{""}}
	got := roundTrip(t, msg, "gnopulse-siwg:abc123")
	if got.Msgs[0].Route() != "vm" {
		t.Fatalf("route: got %q want %q", got.Msgs[0].Route(), "vm")
	}
	call, ok := got.Msgs[0].(vm.MsgCall)
	if !ok {
		t.Fatalf("decoded msg is %T, want vm.MsgCall", got.Msgs[0])
	}
	if call.PkgPath != "gno.land/r/demo/users" || call.Func != "Render" {
		t.Fatalf("payload round-trip: got %+v", call)
	}
}
