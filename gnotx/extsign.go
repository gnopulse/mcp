// External signers for `gnotx serve`. The private key is held by a remote
// enclave or KMS that exposes only a compressed secp256k1 public key and a raw
// 32-byte digest signing primitive; address derivation, sign-doc construction,
// and tx assembly happen here.

package main

import (
	"fmt"
	"os"

	btcec "github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/ecdsa"
	"github.com/gnolang/gno/tm2/pkg/crypto"
	"github.com/gnolang/gno/tm2/pkg/crypto/bip39"
	"github.com/gnolang/gno/tm2/pkg/crypto/hd"
	"github.com/gnolang/gno/tm2/pkg/crypto/secp256k1"
	"github.com/gnolang/gno/tm2/pkg/std"
)

// ExternalSigner signs with a secp256k1 key held outside this process.
type ExternalSigner interface {
	// PubKey returns the signer's secp256k1 public key.
	PubKey() crypto.PubKey
	// SignDigest signs a 32-byte digest and returns a 64-byte R||S signature
	// with low S, the format gno expects.
	SignDigest(digest []byte) ([]byte, error)
}

// signTxExternal signs tx with ext. The digest is SHA-256 of the sign bytes,
// which is what secp256k1.PrivKeySecp256k1.Sign hashes internally, so the result
// verifies the same as a keybase signature.
func signTxExternal(tx *std.Tx, chainID string, accountNumber, sequence uint64, ext ExternalSigner) error {
	signBytes, err := tx.GetSignBytes(chainID, accountNumber, sequence)
	if err != nil {
		return err
	}
	digest := crypto.Sha256(signBytes)
	sig, err := ext.SignDigest(digest)
	if err != nil {
		return fmt.Errorf("external sign: %w", err)
	}
	tx.Signatures = []std.Signature{{PubKey: ext.PubKey(), Signature: sig}}
	return nil
}

// buildExternalSigner returns the signer for a GNOTX_TEE_PROVIDER value.
func buildExternalSigner(provider string) (ExternalSigner, error) {
	switch provider {
	case "local":
		return newLocalRawSigner(os.Getenv("GNOTX_TEE_MNEMONIC"))
	case "turnkey":
		return newTurnkeySigner()
	default:
		return nil, fmt.Errorf("unknown GNOTX_TEE_PROVIDER=%q (local|turnkey)", provider)
	}
}

// localRawSigner implements ExternalSigner with a key derived from a mnemonic.
// It exercises the external signing path without a remote provider.
type localRawSigner struct {
	priv secp256k1.PrivKeySecp256k1
	pub  crypto.PubKey
}

// newLocalRawSigner derives a signer from mnemonic using the default gno HD path.
func newLocalRawSigner(mnemonic string) (ExternalSigner, error) {
	if mnemonic == "" {
		return nil, fmt.Errorf("GNOTX_TEE_PROVIDER=local requires GNOTX_TEE_MNEMONIC")
	}
	seed := bip39.NewSeed(mnemonic, "")
	master, ch := hd.ComputeMastersFromSeed(seed)
	derived, err := hd.DerivePrivateKeyForPath(master, ch, "44'/118'/0'/0/0")
	if err != nil {
		return nil, fmt.Errorf("derive key: %w", err)
	}
	var priv secp256k1.PrivKeySecp256k1
	copy(priv[:], derived[:])
	return &localRawSigner{priv: priv, pub: priv.PubKey()}, nil
}

func (s *localRawSigner) PubKey() crypto.PubKey { return s.pub }

func (s *localRawSigner) SignDigest(digest []byte) ([]byte, error) {
	priv, _ := btcec.PrivKeyFromBytes(s.priv[:])
	// SignCompact returns a recovery byte followed by R||S.
	sig := ecdsa.SignCompact(priv, digest, false)
	return sig[1:], nil
}
