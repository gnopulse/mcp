package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/gnolang/gno/gnovm/pkg/gnolang"
	"github.com/gnolang/gno/tm2/pkg/crypto"
)

// TestReadMemPackageValidates runs gno's package validator locally, since the
// chain's simulation reports only a generic invalid-path error.
func TestReadMemPackageValidates(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "hello.gno"),
		[]byte("package mcphello\n\nfunc Render(path string) string { return \"# hi\" }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	owner := crypto.AddressFromPreimage([]byte("gnotx-test"))
	path := "gno.land/r/" + owner.String() + "/mcphello"
	mpkg, err := readMemPackage(dir, path)
	if err != nil {
		t.Fatalf("readMemPackage: %v", err)
	}
	for i := 1; i < len(mpkg.Files); i++ {
		if mpkg.Files[i-1].Name > mpkg.Files[i].Name {
			t.Fatalf("files not sorted: %q > %q", mpkg.Files[i-1].Name, mpkg.Files[i].Name)
		}
	}
	mpkg.Type = gnolang.MPUserAll // set by the VM keeper before validation
	if err := gnolang.ValidateMemPackageAny(mpkg); err != nil {
		t.Fatalf("ValidateMemPackageAny: %v", err)
	}
	if !gnolang.IsRealmPath(path) {
		t.Fatalf("IsRealmPath(%q) = false", path)
	}
}
