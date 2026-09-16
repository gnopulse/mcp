package main

import (
	"testing"

	"github.com/gnolang/gno/tm2/pkg/crypto/secp256k1"
	"github.com/gnolang/gno/tm2/pkg/sdk/bank"
	"github.com/gnolang/gno/tm2/pkg/std"
)

func signedSIWG(t *testing.T, legacy bool) (std.Tx, secp256k1.PrivKeySecp256k1) {
	t.Helper()
	key := secp256k1.GenPrivKey()
	addr := key.PubKey().Address()
	tx := std.Tx{
		Msgs: []std.Msg{bank.MsgSend{FromAddress: addr, ToAddress: addr, Amount: std.NewCoins(std.NewCoin("ugnot", 1))}},
		Fee:  std.NewFee(100000, std.NewCoin("ugnot", 1000000)),
		Memo: "gnopulse-siwg:nonce",
	}
	sign := tx.GetSignBytes
	if legacy {
		sign = tx.GetSignBytesLegacy
	}
	payload, err := sign("gnoland-1", 7, 3)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := key.Sign(payload)
	if err != nil {
		t.Fatal(err)
	}
	tx.Signatures = []std.Signature{{PubKey: key.PubKey(), Signature: sig}}
	return tx, key
}

func TestVerifyAcceptsBothPayloadRenderings(t *testing.T) {
	for _, tc := range []struct {
		legacy bool
		want   std.PayloadRendering
	}{{false, std.PayloadRenderingCurrent}, {true, std.PayloadRenderingLegacy}} {
		tx, _ := signedSIWG(t, tc.legacy)
		got, err := verifySignature(tx, "gnoland-1", 7, 3)
		if err != nil || got != tc.want {
			t.Fatalf("legacy=%v: got %v, %v; want %v", tc.legacy, got, err, tc.want)
		}
	}
}

func TestVerifyRejectsWrongContext(t *testing.T) {
	tx, _ := signedSIWG(t, false)
	for name, args := range map[string]struct {
		chain    string
		acc, seq uint64
	}{"chain": {"test-13", 7, 3}, "account": {"gnoland-1", 8, 3}, "sequence": {"gnoland-1", 7, 4}} {
		if got, _ := verifySignature(tx, args.chain, args.acc, args.seq); got != std.PayloadRenderingNone {
			t.Fatalf("wrong %s verified as %v", name, got)
		}
	}
	tx.Signatures = nil
	if _, err := verifySignature(tx, "gnoland-1", 7, 3); err == nil {
		t.Fatal("unsigned tx did not error")
	}
}
