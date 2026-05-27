package attach

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCtrlRightBracketIsNotForwarded(t *testing.T) {
	seq := detachSeq{}
	out, detached := seq.filter([]byte{0x1D})
	if !detached {
		t.Fatal("expected detach")
	}
	if len(out) != 0 {
		t.Fatalf("forwarded %q, want no bytes before detach", string(out))
	}
}

func TestAlternateDetachKeysAreNotForwarded(t *testing.T) {
	seq := detachSeq{}
	out, detached := seq.filter([]byte{0x1C})
	if !detached {
		t.Fatal("expected detach for Ctrl-\\")
	}
	if len(out) != 0 {
		t.Fatalf("forwarded %q, want no bytes before detach", string(out))
	}
}

func TestEscRightBracketIsForwarded(t *testing.T) {
	seq := detachSeq{}
	out, detached := seq.filter([]byte{0x1B, ']'})
	if detached {
		t.Fatal("unexpected detach for ESC ]")
	}
	out = append(out, seq.takePending()...)
	if string(out) != "\x1b]" {
		t.Fatalf("forwarded %q, want ESC ]", string(out))
	}
}

func TestKeyboardProtocolDetachSequencesAreNotForwarded(t *testing.T) {
	for _, token := range [][]byte{
		[]byte("\x1b[93;5u"),
		[]byte("\x1b[92;5u"),
		[]byte("\x1b[27;5;93~"),
		[]byte("\x1b[27;5;92~"),
	} {
		seq := detachSeq{}
		out, detached := seq.filter(token)
		if !detached {
			t.Fatalf("expected detach for %q", string(token))
		}
		if len(out) != 0 {
			t.Fatalf("forwarded %q, want no bytes before detach", string(out))
		}
	}
}

func TestNonDetachInputIsForwarded(t *testing.T) {
	seq := detachSeq{}
	out, detached := seq.filter([]byte("hello"))
	if detached {
		t.Fatal("unexpected detach")
	}
	out = append(out, seq.takePending()...)
	if string(out) != "hello" {
		t.Fatalf("forwarded %q, want original input", string(out))
	}
}

func TestDetachTokenAcrossReads(t *testing.T) {
	ws := &recordingWriter{}
	err := copyInput(ws, &chunkReader{chunks: [][]byte{{0x1D}}})
	if !errors.Is(err, errDetached) {
		t.Fatalf("copyInput error = %v, want detached", err)
	}
	if len(ws.messages) != 0 {
		t.Fatalf("messages = %d, want no forwarded detach token", len(ws.messages))
	}
}

func TestDetachMessage(t *testing.T) {
	if string(detachMessage()) != `{"type":"detach"}` {
		t.Fatalf("detachMessage = %s", detachMessage())
	}
}

func TestReplayLogsUsesAttachURLAndToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/sessions/abc/logs" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if r.URL.Query().Get("tail") != "500" {
			t.Fatalf("tail = %s", r.URL.Query().Get("tail"))
		}
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Fatalf("authorization = %s", r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`{"lines":[{"content":"aGk="}]}`))
	}))
	defer server.Close()

	var out recordingBuffer
	if err := replayLogs(server.URL+"/api/v1/sessions/abc/attach", "token", &out); err != nil {
		t.Fatal(err)
	}
	if string(out.bytes) != "hi" {
		t.Fatalf("out = %q", string(out.bytes))
	}
}

func TestSanitizeReplayStripsTerminalQueries(t *testing.T) {
	in := []byte("a\x1b]11;?\x1b\\b\x1b[?1;2cc\x1b[31md\x1b[0me")
	out := sanitizeReplay(in)
	if string(out) != "abc\x1b[31md\x1b[0me" {
		t.Fatalf("out = %q", string(out))
	}
}

func TestSanitizeReplayStripsKeyboardProtocolQuery(t *testing.T) {
	in := []byte("a\x1b[?7ub")
	out := sanitizeReplay(in)
	if string(out) != "ab" {
		t.Fatalf("out = %q", string(out))
	}
}

func TestAdaptOutputColorsRewritesBlackForeground(t *testing.T) {
	in := []byte("a\x1b[30mblack\x1b[0m b\x1b[1;30;4mcombo")
	out := adaptOutputColors(in, false)
	want := "a\x1b[39mblack\x1b[0m b\x1b[1;39;4mcombo"
	if string(out) != want {
		t.Fatalf("out = %q, want %q", string(out), want)
	}
}

func TestAdaptOutputColorsRewritesIndexedBlackForeground(t *testing.T) {
	in := []byte("a\x1b[38;5;0mblack")
	out := adaptOutputColors(in, false)
	want := "a\x1b[39mblack"
	if string(out) != want {
		t.Fatalf("out = %q, want %q", string(out), want)
	}
}

func TestAdaptOutputColorsRewritesRGBBlackForeground(t *testing.T) {
	in := []byte("a\x1b[38;2;0;0;0mblack")
	out := adaptOutputColors(in, false)
	want := "a\x1b[39mblack"
	if string(out) != want {
		t.Fatalf("out = %q, want %q", string(out), want)
	}
}

func TestAdaptOutputColorsLeavesOtherColors(t *testing.T) {
	in := []byte("a\x1b[31mred\x1b[38;5;8mgray")
	out := adaptOutputColors(in, false)
	if string(out) != string(in) {
		t.Fatalf("out = %q, want original", string(out))
	}
}

func TestAdaptOutputColorsDarkBgLeavesWhiteForeground(t *testing.T) {
	in := []byte("a\x1b[37mwhite\x1b[97mbright")
	out := adaptOutputColors(in, false)
	if string(out) != string(in) {
		t.Fatalf("dark bg: out = %q, want original (white fg must not be rewritten)", string(out))
	}
}

func TestAdaptOutputColorsLightBgRewritesWhiteForeground(t *testing.T) {
	in := []byte("a\x1b[37mwhite\x1b[0m b\x1b[1;97;4mbright")
	out := adaptOutputColors(in, true)
	want := "a\x1b[39mwhite\x1b[0m b\x1b[1;39;4mbright"
	if string(out) != want {
		t.Fatalf("light bg: out = %q, want %q", string(out), want)
	}
}

func TestAdaptOutputColorsLightBgRewritesIndexedWhiteForeground(t *testing.T) {
	for _, palIdx := range []string{"7", "15"} {
		in := []byte("a\x1b[38;5;" + palIdx + "mwhite")
		out := adaptOutputColors(in, true)
		want := "a\x1b[39mwhite"
		if string(out) != want {
			t.Fatalf("light bg 38;5;%s: out = %q, want %q", palIdx, string(out), want)
		}
	}
}

func TestAdaptOutputColorsLightBgRewritesRGBWhiteForeground(t *testing.T) {
	in := []byte("a\x1b[38;2;255;255;255mwhite")
	out := adaptOutputColors(in, true)
	want := "a\x1b[39mwhite"
	if string(out) != want {
		t.Fatalf("light bg RGB white: out = %q, want %q", string(out), want)
	}
}

func TestAdaptOutputColorsLightBgLeavesNonWhiteColors(t *testing.T) {
	in := []byte("a\x1b[31mred\x1b[38;5;9mbright-red\x1b[38;2;0;128;255mblue")
	out := adaptOutputColors(in, true)
	if string(out) != string(in) {
		t.Fatalf("light bg: out = %q, want original (non-white colors must not be rewritten)", string(out))
	}
}

func TestAdaptOutputColorsLightBgLeavesBlackForeground(t *testing.T) {
	in := []byte("a\x1b[30mblack")
	out := adaptOutputColors(in, true)
	if string(out) != string(in) {
		t.Fatalf("light bg: out = %q, want original (black fg must not be rewritten on light bg)", string(out))
	}
}

func TestParseOSC11LuminanceWhiteBackground(t *testing.T) {
	// Mac Terminal default white background
	data := []byte("\x1b]11;rgb:ffff/ffff/ffff\a")
	lum, ok := parseOSC11Luminance(data)
	if !ok {
		t.Fatal("expected ok")
	}
	if lum < 0.99 {
		t.Fatalf("lum = %f, want ~1.0 for white", lum)
	}
}

func TestParseOSC11LuminanceDarkBackground(t *testing.T) {
	// Typical VS Code dark background
	data := []byte("\x1b]11;rgb:1e1e/1e1e/1e1e\a")
	lum, ok := parseOSC11Luminance(data)
	if !ok {
		t.Fatal("expected ok")
	}
	if lum > 0.2 {
		t.Fatalf("lum = %f, want < 0.2 for dark bg", lum)
	}
}

func TestParseOSC11LuminanceSTTerminator(t *testing.T) {
	// Some terminals use ST (\x1b\\) instead of BEL
	data := []byte("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")
	lum, ok := parseOSC11Luminance(data)
	if !ok {
		t.Fatal("expected ok with ST terminator")
	}
	if lum < 0.99 {
		t.Fatalf("lum = %f, want ~1.0", lum)
	}
}

func TestParseOSC11LuminanceIncomplete(t *testing.T) {
	// Partial response (no terminator yet) must return not-ok
	data := []byte("\x1b]11;rgb:ffff/ffff")
	_, ok := parseOSC11Luminance(data)
	if ok {
		t.Fatal("expected not-ok for incomplete response")
	}
}

type recordingWriter struct {
	messages [][]byte
}

func (w *recordingWriter) writeText(payload []byte) error {
	w.messages = append(w.messages, append([]byte(nil), payload...))
	return nil
}

type recordingBuffer struct {
	bytes []byte
}

func (b *recordingBuffer) Write(p []byte) (int, error) {
	b.bytes = append(b.bytes, p...)
	return len(p), nil
}

type chunkReader struct {
	chunks [][]byte
}

func (r *chunkReader) Read(p []byte) (int, error) {
	if len(r.chunks) == 0 {
		return 0, io.EOF
	}
	chunk := r.chunks[0]
	r.chunks = r.chunks[1:]
	return copy(p, chunk), nil
}

func TestDetachErrorIsSentinel(t *testing.T) {
	if !errors.Is(errDetached, errDetached) {
		t.Fatal("detach sentinel should match itself")
	}
}

func TestReportInputErrorIgnoresEOF(t *testing.T) {
	var out recordingBuffer
	reportInputError(&out, io.EOF)
	if len(out.bytes) != 0 {
		t.Fatalf("output = %q, want empty", string(out.bytes))
	}
}

func TestReportInputErrorPrintsNonEOF(t *testing.T) {
	var out recordingBuffer
	reportInputError(&out, errors.New("read failed"))
	if string(out.bytes) != "\r\n[orb] stdin relay stopped: read failed\r\n" {
		t.Fatalf("output = %q", string(out.bytes))
	}
}
