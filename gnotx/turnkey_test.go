package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"testing"
)

// TestTurnkeyStampVerifies checks P-256 key parsing and that the request stamp
// is a valid signature over the body under the advertised public key.
func TestTurnkeyStampVerifies(t *testing.T) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keyHex := hex.EncodeToString(priv.D.Bytes())

	parsed, apiPubHex, err := parseP256(keyHex)
	if err != nil {
		t.Fatalf("parseP256: %v", err)
	}
	if parsed.D.Cmp(priv.D) != 0 {
		t.Fatal("parsed private key mismatch")
	}

	ts := &turnkeySigner{apiKey: parsed, apiPubHex: apiPubHex}
	body := []byte(`{"type":"ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2"}`)
	stampHeader, err := ts.stamp(body)
	if err != nil {
		t.Fatalf("stamp: %v", err)
	}

	rawObj, err := base64.RawURLEncoding.DecodeString(stampHeader)
	if err != nil {
		t.Fatalf("stamp not base64url: %v", err)
	}
	var obj struct {
		PublicKey string `json:"publicKey"`
		Scheme    string `json:"scheme"`
		Signature string `json:"signature"`
	}
	if err := json.Unmarshal(rawObj, &obj); err != nil {
		t.Fatalf("stamp json: %v", err)
	}
	if obj.Scheme != "SIGNATURE_SCHEME_TK_API_P256" {
		t.Fatalf("scheme = %q", obj.Scheme)
	}

	pubBytes, err := hex.DecodeString(obj.PublicKey)
	if err != nil {
		t.Fatalf("pubkey hex: %v", err)
	}
	x, y := elliptic.UnmarshalCompressed(elliptic.P256(), pubBytes)
	if x == nil {
		t.Fatal("advertised pubkey is not a valid compressed P-256 point")
	}
	pub := &ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}

	der, err := hex.DecodeString(obj.Signature)
	if err != nil {
		t.Fatalf("sig hex: %v", err)
	}
	h := sha256.Sum256(body)
	if !ecdsa.VerifyASN1(pub, h[:], der) {
		t.Fatal("stamp signature failed to verify against advertised pubkey")
	}

	wantX, wantY := elliptic.P256().ScalarBaseMult(priv.D.Bytes())
	if x.Cmp(wantX) != 0 || y.Cmp(wantY) != 0 {
		t.Fatal("advertised pubkey != derived from private key")
	}
}
