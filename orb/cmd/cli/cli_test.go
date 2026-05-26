package cli

import "testing"

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
