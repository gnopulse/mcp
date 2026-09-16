// Turnkey external signer (https://turnkey.com).
//
// The wallet key stays in Turnkey. SignDigest calls sign_raw_payload with
// HASH_FUNCTION_NO_OP on the precomputed digest, authenticated by an X-Stamp
// header signed with a P-256 API key. This backend has not been verified
// against the live Turnkey API.
//
// Environment:
//
//	TURNKEY_ORG_ID           organization id
//	TURNKEY_SIGN_WITH        private key id or address to sign with
//	TURNKEY_API_PRIVATE_KEY  hex P-256 API private key
//	TURNKEY_PUBKEY           hex 33-byte compressed secp256k1 wallet public key
//	TURNKEY_BASE_URL         API base URL (default https://api.turnkey.com)

package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"time"

	"github.com/gnolang/gno/tm2/pkg/crypto"
	"github.com/gnolang/gno/tm2/pkg/crypto/secp256k1"
)

// maxResponseBytes caps how much of a Turnkey response is read.
const maxResponseBytes = 1 << 20

type turnkeySigner struct {
	baseURL   string
	orgID     string
	signWith  string
	apiKey    *ecdsa.PrivateKey // P-256 key that stamps requests
	apiPubHex string            // compressed P-256 public key, hex
	walletPub crypto.PubKey     // secp256k1 wallet public key
	http      *http.Client
}

// newTurnkeySigner builds a Turnkey signer from the TURNKEY_* environment variables.
func newTurnkeySigner() (ExternalSigner, error) {
	orgID := os.Getenv("TURNKEY_ORG_ID")
	signWith := os.Getenv("TURNKEY_SIGN_WITH")
	apiPrivHex := os.Getenv("TURNKEY_API_PRIVATE_KEY")
	pubHex := os.Getenv("TURNKEY_PUBKEY")
	if orgID == "" || signWith == "" || apiPrivHex == "" || pubHex == "" {
		return nil, errors.New("turnkey provider needs TURNKEY_ORG_ID, TURNKEY_SIGN_WITH, " +
			"TURNKEY_API_PRIVATE_KEY, TURNKEY_PUBKEY (compressed secp256k1 wallet pubkey)")
	}

	apiKey, apiPubHexStr, err := parseP256(apiPrivHex)
	if err != nil {
		return nil, fmt.Errorf("TURNKEY_API_PRIVATE_KEY: %w", err)
	}
	pubRaw, err := hex.DecodeString(pubHex)
	if err != nil || len(pubRaw) != secp256k1.PubKeySecp256k1Size {
		return nil, errors.New("TURNKEY_PUBKEY must be a 33-byte compressed secp256k1 pubkey (hex)")
	}
	var wp secp256k1.PubKeySecp256k1
	copy(wp[:], pubRaw)

	base := os.Getenv("TURNKEY_BASE_URL")
	if base == "" {
		base = "https://api.turnkey.com"
	}
	return &turnkeySigner{
		baseURL: base, orgID: orgID, signWith: signWith,
		apiKey: apiKey, apiPubHex: apiPubHexStr, walletPub: wp,
		http: &http.Client{Timeout: 20 * time.Second},
	}, nil
}

func (t *turnkeySigner) PubKey() crypto.PubKey { return t.walletPub }

func (t *turnkeySigner) SignDigest(digest []byte) ([]byte, error) {
	body, err := json.Marshal(map[string]any{
		"type":           "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
		"timestampMs":    fmt.Sprint(time.Now().UnixMilli()),
		"organizationId": t.orgID,
		"parameters": map[string]any{
			"signWith":     t.signWith,
			"payload":      hex.EncodeToString(digest),
			"encoding":     "PAYLOAD_ENCODING_HEXADECIMAL",
			"hashFunction": "HASH_FUNCTION_NO_OP", // digest is already hashed
		},
	})
	if err != nil {
		return nil, err
	}

	stamp, err := t.stamp(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, t.baseURL+"/public/v1/submit/sign_raw_payload", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Stamp", stamp)

	resp, err := t.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("turnkey request: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("turnkey response read: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("turnkey HTTP %d: %s", resp.StatusCode, string(raw))
	}

	var out struct {
		Activity struct {
			Status string `json:"status"`
			Result struct {
				SignRawPayloadResult struct {
					R string `json:"r"`
					S string `json:"s"`
				} `json:"signRawPayloadResult"`
			} `json:"result"`
		} `json:"activity"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("turnkey response parse: %w (%s)", err, string(raw))
	}
	r := out.Activity.Result.SignRawPayloadResult.R
	s := out.Activity.Result.SignRawPayloadResult.S
	if r == "" || s == "" {
		return nil, fmt.Errorf("turnkey returned no signature (status=%s): %s", out.Activity.Status, string(raw))
	}
	rb, err1 := hex.DecodeString(r)
	sb, err2 := hex.DecodeString(s)
	if err1 != nil || err2 != nil || len(rb) != 32 || len(sb) != 32 {
		return nil, errors.New("turnkey r/s not 32-byte hex")
	}
	return append(rb, sb...), nil
}

// stamp builds the X-Stamp header: base64url of JSON {publicKey, scheme,
// signature}, where signature is a DER P-256 ECDSA-SHA256 signature over body.
func (t *turnkeySigner) stamp(body []byte) (string, error) {
	h := sha256.Sum256(body)
	der, err := ecdsa.SignASN1(rand.Reader, t.apiKey, h[:])
	if err != nil {
		return "", err
	}
	obj, err := json.Marshal(map[string]string{
		"publicKey": t.apiPubHex,
		"scheme":    "SIGNATURE_SCHEME_TK_API_P256",
		"signature": hex.EncodeToString(der),
	})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(obj), nil
}

// parseP256 parses a hex P-256 private key and returns it with its compressed
// public key in hex.
func parseP256(hexKey string) (*ecdsa.PrivateKey, string, error) {
	d, err := hex.DecodeString(hexKey)
	if err != nil {
		return nil, "", errors.New("not hex")
	}
	curve := elliptic.P256()
	k := new(big.Int).SetBytes(d)
	priv := &ecdsa.PrivateKey{PublicKey: ecdsa.PublicKey{Curve: curve}, D: k}
	priv.PublicKey.X, priv.PublicKey.Y = curve.ScalarBaseMult(d)
	return priv, hex.EncodeToString(elliptic.MarshalCompressed(curve, priv.PublicKey.X, priv.PublicKey.Y)), nil
}
