package cli

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"orb/internal/client"
)

func TestSanitizeLogOutputStripsTerminalControl(t *testing.T) {
	in := []byte("one\x1b[2J\x1b[Htwo\rthree\x1b]0;title\x07\n")
	got := string(sanitizeLogOutput(in))
	want := "onetwo\nthree\n"
	if got != want {
		t.Fatalf("sanitizeLogOutput() = %q, want %q", got, want)
	}
}

func TestSanitizeLogOutputCompactsBlankLines(t *testing.T) {
	in := []byte("one\r\r\n\n\n\ntwo")
	got := string(sanitizeLogOutput(in))
	want := "one\n\ntwo\n"
	if got != want {
		t.Fatalf("sanitizeLogOutput() = %q, want %q", got, want)
	}
}

func TestSanitizeLogOutputAppliesBackspace(t *testing.T) {
	in := []byte("hellp\bo")
	got := string(sanitizeLogOutput(in))
	want := "hello\n"
	if got != want {
		t.Fatalf("sanitizeLogOutput() = %q, want %q", got, want)
	}
}

func TestRemoveDeletesMultipleSessions(t *testing.T) {
	var got []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Fatalf("method = %s, want DELETE", r.Method)
		}
		got = append(got, r.URL.RequestURI())
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	c := client.Client{Base: server.URL, Token: "test-token"}
	if err := remove(c, []string{"one", "two words", "three"}); err != nil {
		t.Fatalf("remove() error = %v", err)
	}

	want := []string{"/api/v1/sessions/one", "/api/v1/sessions/two%20words", "/api/v1/sessions/three"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("delete paths = %#v, want %#v", got, want)
	}
}

func TestRemoveRequiresAtLeastOneSession(t *testing.T) {
	err := remove(client.Client{}, nil)
	if err == nil {
		t.Fatal("remove() error = nil, want usage error")
	}
}
