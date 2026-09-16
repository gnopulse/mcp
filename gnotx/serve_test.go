package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testToken = "s3cret"

// newTestServer returns a serve mux whose runner records the requests it receives.
func newTestServer(t *testing.T) (*httptest.Server, *[]callReq) {
	t.Helper()
	var got []callReq
	health := func() map[string]any { return map[string]any{"ok": true, "caller": "g1test"} }
	run := func(req callReq, broadcast bool) (*result, string, int, error) {
		got = append(got, req)
		return &result{Mode: "simulate", Caller: "g1test", Func: req.Pkgpath + "." + req.Func, OK: true}, "", 0, nil
	}
	srv := httptest.NewServer(newServeMux(testToken, health, run))
	t.Cleanup(srv.Close)
	return srv, &got
}

func post(t *testing.T, url, auth, contentType, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

const validBody = `{"pkgpath":"gno.land/r/demo/x","func":"Do","args":["1"]}`

func TestCheckServeTokenRequiresToken(t *testing.T) {
	if err := checkServeToken("", false); err == nil {
		t.Fatal("empty token without -insecure-no-token must refuse to start")
	}
	if err := checkServeToken("", true); err != nil {
		t.Fatalf("-insecure-no-token: %v", err)
	}
	if err := checkServeToken(testToken, false); err != nil {
		t.Fatalf("token set: %v", err)
	}
}

func TestServeRejectsBadToken(t *testing.T) {
	srv, got := newTestServer(t)
	for _, auth := range []string{"", "Bearer wrong", testToken, "Bearer " + testToken + "x"} {
		resp := post(t, srv.URL+"/execute", auth, "application/json", validBody)
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("auth %q: status %d, want 401", auth, resp.StatusCode)
		}
	}
	if len(*got) != 0 {
		t.Fatalf("handler reached %d times", len(*got))
	}
}

func TestServeRejectsContentType(t *testing.T) {
	srv, got := newTestServer(t)
	for _, ct := range []string{"", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data"} {
		resp := post(t, srv.URL+"/simulate", "Bearer "+testToken, ct, validBody)
		if resp.StatusCode != http.StatusUnsupportedMediaType {
			t.Errorf("content type %q: status %d, want 415", ct, resp.StatusCode)
		}
	}
	if len(*got) != 0 {
		t.Fatalf("handler reached %d times", len(*got))
	}
}

func TestServeRejectsOversizedBody(t *testing.T) {
	srv, got := newTestServer(t)
	big := `{"pkgpath":"gno.land/r/demo/x","func":"Do","send":"` + strings.Repeat("a", maxRequestBytes) + `"}`
	resp := post(t, srv.URL+"/execute", "Bearer "+testToken, "application/json", big)
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status %d, want 413", resp.StatusCode)
	}
	if len(*got) != 0 {
		t.Fatalf("handler reached %d times", len(*got))
	}
}

func TestServeValidRequestReachesHandler(t *testing.T) {
	srv, got := newTestServer(t)
	resp := post(t, srv.URL+"/simulate", "Bearer "+testToken, "application/json; charset=utf-8", validBody)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d, want 200", resp.StatusCode)
	}
	var res result
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if !res.OK || res.Func != "gno.land/r/demo/x.Do" {
		t.Fatalf("unexpected result %+v", res)
	}
	if len(*got) != 1 || (*got)[0].Args[0] != "1" {
		t.Fatalf("handler got %+v", *got)
	}
}

func TestServeHealthzNeedsNoToken(t *testing.T) {
	srv, _ := newTestServer(t)
	resp, err := http.Get(srv.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK || body["caller"] != "g1test" {
		t.Fatalf("status %d body %v", resp.StatusCode, body)
	}
}

func TestBuildSignerRequiresKey(t *testing.T) {
	_, _, err := buildSigner(&config{home: t.TempDir()})
	if err == nil || !strings.Contains(err.Error(), "-key is required") {
		t.Fatalf("err = %v, want -key is required", err)
	}
}

func TestDefHome(t *testing.T) {
	t.Setenv("GNOTX_HOME", "")
	t.Setenv("GNOHOME", "")
	dir, err := os.UserConfigDir()
	if err != nil {
		t.Skip("no user config dir")
	}
	if got, want := defHome(), filepath.Join(dir, "gno"); got != want {
		t.Fatalf("defHome() = %q, want %q", got, want)
	}
	t.Setenv("GNOTX_HOME", "/tmp/k")
	if got := defHome(); got != "/tmp/k" {
		t.Fatalf("GNOTX_HOME override: %q", got)
	}
}
