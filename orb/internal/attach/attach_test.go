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
	out := adaptOutputColors(in)
	want := "a\x1b[39mblack\x1b[0m b\x1b[1;39;4mcombo"
	if string(out) != want {
		t.Fatalf("out = %q, want %q", string(out), want)
	}
}

func TestAdaptOutputColorsRewritesIndexedBlackForeground(t *testing.T) {
	in := []byte("a\x1b[38;5;0mblack")
	out := adaptOutputColors(in)
	want := "a\x1b[39mblack"
	if string(out) != want {
		t.Fatalf("out = %q, want %q", string(out), want)
	}
}

func TestAdaptOutputColorsRewritesRGBBlackForeground(t *testing.T) {
	in := []byte("a\x1b[38;2;0;0;0mblack")
	out := adaptOutputColors(in)
	want := "a\x1b[39mblack"
	if string(out) != want {
		t.Fatalf("out = %q, want %q", string(out), want)
	}
}

func TestAdaptOutputColorsLeavesOtherColors(t *testing.T) {
	in := []byte("a\x1b[31mred\x1b[38;5;8mgray")
	out := adaptOutputColors(in)
	if string(out) != string(in) {
		t.Fatalf("out = %q, want original", string(out))
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
