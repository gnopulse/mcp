package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gnolang/gno/tm2/pkg/crypto/keys"
	"github.com/gnolang/gno/tm2/pkg/crypto/keys/armor"
)

// withStdin runs fn with text as stdin.
func withStdin(t *testing.T, text string, fn func() error) error {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	w.WriteString(text)
	w.Close()
	old := os.Stdin
	os.Stdin = r
	defer func() { os.Stdin = old }()
	return fn()
}

func TestReadSecretsRejectsAnythingButJSON(t *testing.T) {
	if _, err := readSecrets(strings.NewReader("hunter2\n")); err == nil {
		t.Fatal("a plain line was accepted")
	}
	s, err := readSecrets(strings.NewReader(`{"password":"p","serve_token":"t"}` + "\nignored"))
	if err != nil || s.Password != "p" || s.ServeToken != "t" {
		t.Fatalf("got %+v, %v", s, err)
	}
}

func TestPhraseAndExportRecoverTheSameWallet(t *testing.T) {
	mnemonic, err := newMnemonic()
	if err != nil {
		t.Fatal(err)
	}
	if n := len(strings.Fields(mnemonic)); n != 24 {
		t.Fatalf("phrase has %d words", n)
	}
	home := t.TempDir()
	line := `{"password":"pw","mnemonic":"` + mnemonic + `"}` + "\n"
	create := func() error { return cmdKeygen([]string{"-home", home, "-key", "k", "-secrets-stdin"}) }
	if err := withStdin(t, line, create); err != nil {
		t.Fatal(err)
	}
	if err := withStdin(t, line, create); err == nil {
		t.Fatal("a second phrase was accepted for an existing wallet")
	}

	kb, err := keys.NewKeyBaseFromDir(home)
	if err != nil {
		t.Fatal(err)
	}
	info, err := kb.GetByName("k")
	if err != nil {
		t.Fatal(err)
	}
	want := info.GetAddress()

	// The phrase alone rebuilds the address, the way another wallet would.
	other, err := keys.NewKeyBaseFromDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	restored, err := other.CreateAccount("r", mnemonic, "", "new", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if restored.GetAddress() != want {
		t.Fatalf("phrase gave %s, want %s", restored.GetAddress(), want)
	}

	// The encrypted file decrypts to the same key, and only with its passphrase.
	out := filepath.Join(t.TempDir(), "wallet.key")
	export := func() error { return cmdExport([]string{"-home", home, "-key", "k", "-out", out}) }
	if err := withStdin(t, `{"password":"pw","passphrase":"long passphrase"}`+"\n", export); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	priv, err := armor.UnarmorDecryptPrivKey(string(body), "long passphrase")
	if err != nil || priv.PubKey().Address() != want {
		t.Fatalf("export decrypted to the wrong key: %v", err)
	}
	if _, err := armor.UnarmorDecryptPrivKey(string(body), "wrong"); err == nil {
		t.Fatal("a wrong passphrase decrypted the export")
	}
	if err := withStdin(t, `{"password":"pw","passphrase":"long passphrase"}`+"\n", export); err == nil {
		t.Fatal("export replaced an existing file")
	}
	if err := withStdin(t, `{"password":"bad","passphrase":"x"}`+"\n", func() error {
		return cmdExport([]string{"-home", home, "-key", "k", "-out", out + ".2"})
	}); err == nil {
		t.Fatal("export worked with the wrong wallet password")
	}
}

func TestKeygenNoCreateLeavesNoWallet(t *testing.T) {
	home := t.TempDir()
	check := func() error {
		return cmdKeygen([]string{"-home", home, "-key", "k", "-no-create", "-secrets-stdin"})
	}
	if err := withStdin(t, `{"password":"pw"}`+"\n", check); err != nil {
		t.Fatal(err)
	}
	kb, err := keys.NewKeyBaseFromDir(home)
	if err != nil {
		t.Fatal(err)
	}
	if has, _ := kb.HasByName("k"); has {
		t.Fatal("-no-create made a wallet")
	}
}
