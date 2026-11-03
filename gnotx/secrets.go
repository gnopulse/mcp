package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/gnolang/gno/tm2/pkg/crypto/bip39"
	"github.com/gnolang/gno/tm2/pkg/crypto/keys/armor"
)

// pipedSecrets arrive as one JSON line on stdin with -secrets-stdin, so they never appear in the
// process's arguments or environment, which other programs under the same account can read.
type pipedSecrets struct {
	Password   string `json:"password"`
	ServeToken string `json:"serve_token"`
	Passphrase string `json:"passphrase"`
	Mnemonic   string `json:"mnemonic"`
}

func readSecrets(r io.Reader) (pipedSecrets, error) {
	var s pipedSecrets
	line, err := bufio.NewReader(r).ReadBytes('\n')
	if err != nil && err != io.EOF {
		return s, fmt.Errorf("read secrets from stdin: %w", err)
	}
	if err := json.Unmarshal(line, &s); err != nil {
		return s, fmt.Errorf("secrets on stdin must be one JSON line")
	}
	return s, nil
}

// newMnemonic returns a fresh 24-word recovery phrase.
func newMnemonic() (string, error) {
	entropy, err := bip39.NewEntropy(256)
	if err != nil {
		return "", fmt.Errorf("entropy: %w", err)
	}
	mnemonic, err := bip39.NewMnemonic(entropy)
	if err != nil {
		return "", fmt.Errorf("mnemonic: %w", err)
	}
	return mnemonic, nil
}

// cmdMnemonic prints a new recovery phrase and stores nothing, so a caller can have it saved
// before the wallet exists.
func cmdMnemonic(args []string) error {
	fs := flag.NewFlagSet("mnemonic", flag.ExitOnError)
	if err := fs.Parse(args); err != nil {
		return err
	}
	mnemonic, err := newMnemonic()
	if err != nil {
		return err
	}
	emit(map[string]string{"mnemonic": mnemonic})
	return nil
}

// cmdExport writes the key to a new file, encrypted with a passphrase, in the armor format that
// `gnokey import` reads. It decrypts the file again before reporting success.
func cmdExport(args []string) error {
	fs := flag.NewFlagSet("export", flag.ExitOnError)
	var home, key, out string
	fs.StringVar(&home, "home", defHome(), "keybase directory (holds keys.db)")
	fs.StringVar(&key, "key", env("GNOTX_KEY", "gpagent"), "key name to export")
	fs.StringVar(&out, "out", "", "new file to write; an existing file is never replaced")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if out == "" {
		return fmt.Errorf("export needs -out")
	}
	secrets, err := readSecrets(os.Stdin)
	if err != nil {
		return err
	}
	if secrets.Passphrase == "" {
		return fmt.Errorf("export needs a passphrase")
	}
	kb, err := keysFromDir(home)
	if err != nil {
		return fmt.Errorf("open keybase at %q: %w", home, err)
	}
	priv, err := kb.ExportPrivKey(key, secrets.Password)
	if err != nil {
		return fmt.Errorf("read key %q: %w", key, err)
	}
	armored := armor.EncryptArmorPrivKey(priv, secrets.Passphrase)
	back, err := armor.UnarmorDecryptPrivKey(armored, secrets.Passphrase)
	if err != nil || back.PubKey().Address() != priv.PubKey().Address() {
		return fmt.Errorf("the encrypted export did not decrypt back to this wallet")
	}
	file, err := os.OpenFile(out, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create %q: %w", out, err)
	}
	if _, err := file.WriteString(armored + "\n"); err != nil {
		file.Close()
		return fmt.Errorf("write %q: %w", out, err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("write %q: %w", out, err)
	}
	emit(map[string]string{"address": priv.PubKey().Address().String(), "file": out})
	return nil
}
