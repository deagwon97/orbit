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

func TestKeepLocalScrollbackStripsMouseTrackingEnable(t *testing.T) {
	in := []byte("a\x1b[?1000hb\x1b[?1002;1005;1006;1015hc\x1b[?1007hd")
	out := keepLocalScrollback(in)
	if string(out) != "abcd" {
		t.Fatalf("out = %q, want mouse enable stripped", string(out))
	}
}

func TestKeepLocalScrollbackKeepsMouseTrackingDisable(t *testing.T) {
	in := []byte("a\x1b[?1000lb")
	out := keepLocalScrollback(in)
	if string(out) != string(in) {
		t.Fatalf("out = %q, want original", string(out))
	}
}

func TestKeepLocalScrollbackStripsAlternateScreen(t *testing.T) {
	in := []byte("a\x1b[?1049hb\x1b[?1049lc")
	out := keepLocalScrollback(in)
	if string(out) != "abc" {
		t.Fatalf("out = %q, want alternate screen stripped", string(out))
	}
}

func TestKeepLocalScrollbackLeavesOtherCSI(t *testing.T) {
	in := []byte("a\x1b[31mred\x1b[?25lb")
	out := keepLocalScrollback(in)
	if string(out) != string(in) {
		t.Fatalf("out = %q, want original", string(out))
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

func TestAdaptOutputColorsStripsAllExplicitBackgrounds(t *testing.T) {
	// All explicit backgrounds are stripped because keepLocalScrollback forces
	// session content onto the normal screen; any background from the TUI app
	// clashes with the user's terminal theme regardless of colour.
	for _, tc := range []struct {
		name    string
		in      string
		lightBg bool
		want    string
	}{
		{
			name:    "dark: black fg on green background — bg stripped, fg remapped",
			in:      "a\x1b[42;30mblack-on-green",
			lightBg: false,
			want:    "a\x1b[49;39mblack-on-green",
		},
		{
			name:    "dark: black fg then red background — bg stripped, fg remapped",
			in:      "a\x1b[30;41mblack-on-red",
			lightBg: false,
			want:    "a\x1b[39;49mblack-on-red",
		},
		{
			name:    "light: white fg on red background — bg stripped, fg remapped",
			in:      "a\x1b[41;37mwhite-on-red",
			lightBg: true,
			want:    "a\x1b[49;39mwhite-on-red",
		},
		{
			name:    "light: indexed white on indexed green background — both stripped",
			in:      "a\x1b[48;5;2;38;5;15mwhite-on-green",
			lightBg: true,
			want:    "a\x1b[49;39mwhite-on-green",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := adaptOutputColors([]byte(tc.in), tc.lightBg)
			if string(out) != tc.want {
				t.Fatalf("out = %q, want %q", string(out), tc.want)
			}
		})
	}
}

func TestAdaptOutputColorsStripsExplicitBackgroundAcrossChunks(t *testing.T) {
	// Even after stripping, the state update ensures fg is remapped in later chunks.
	adapter := newColorAdapter(false)
	if out := adapter.adapt([]byte("\x1b[42m")); string(out) != "\x1b[49m" {
		t.Fatalf("background chunk out = %q, want stripped to default", string(out))
	}
	// bg was stripped → explicitBg=false → black fg is remapped immediately
	if out := adapter.adapt([]byte("\x1b[30mtext")); string(out) != "\x1b[39mtext" {
		t.Fatalf("foreground chunk out = %q, want black rewritten (no explicit bg)", string(out))
	}
	if out := adapter.adapt([]byte("\x1b[49m\x1b[30mtext")); string(out) != "\x1b[49m\x1b[39mtext" {
		t.Fatalf("reset chunk out = %q", string(out))
	}
}

func TestAdaptOutputColorsLeavesForegroundInInverseMode(t *testing.T) {
	in := []byte("a\x1b[7;30minverse\x1b[27m\x1b[30mnormal")
	out := adaptOutputColors(in, false)
	want := "a\x1b[7;30minverse\x1b[27m\x1b[39mnormal"
	if string(out) != want {
		t.Fatalf("out = %q, want %q", string(out), want)
	}
}

func TestAdaptOutputColorsRewritesAmbientDarkBackground(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   string
		want string
	}{
		{
			name: "ansi black bg on dark terminal",
			in:   "a\x1b[40;37mtext",
			want: "a\x1b[49;37mtext",
		},
		{
			name: "indexed dark gray (235) bg on dark terminal",
			in:   "a\x1b[48;5;235;37mtext",
			want: "a\x1b[49;37mtext",
		},
		{
			name: "indexed medium gray (244) bg on dark terminal",
			in:   "a\x1b[48;5;244;37mtext",
			want: "a\x1b[49;37mtext",
		},
		{
			name: "indexed bright-black (8) bg on dark terminal",
			in:   "a\x1b[48;5;8;37mtext",
			want: "a\x1b[49;37mtext",
		},
		{
			name: "rgb near-black bg on dark terminal",
			in:   "a\x1b[48;2;40;44;52;37mtext",
			want: "a\x1b[49;37mtext",
		},
		{
			name: "rgb dark gray bg on dark terminal",
			in:   "a\x1b[48;2;60;60;60;37mtext",
			want: "a\x1b[49;37mtext",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := adaptOutputColors([]byte(tc.in), false)
			if string(out) != tc.want {
				t.Fatalf("out = %q, want %q", string(out), tc.want)
			}
		})
	}
}

func TestAdaptOutputColorsRewritesAmbientLightBackground(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   string
		want string
	}{
		{
			name: "ansi white bg on light terminal",
			in:   "a\x1b[47;30mtext",
			want: "a\x1b[49;30mtext",
		},
		{
			name: "indexed near-white (253) bg on light terminal",
			in:   "a\x1b[48;5;253;30mtext",
			want: "a\x1b[49;30mtext",
		},
		{
			name: "rgb near-white bg on light terminal",
			in:   "a\x1b[48;2;240;240;240;30mtext",
			want: "a\x1b[49;30mtext",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := adaptOutputColors([]byte(tc.in), true)
			if string(out) != tc.want {
				t.Fatalf("out = %q, want %q", string(out), tc.want)
			}
		})
	}
}

func TestAdaptOutputColorsRewritesHarshYellowBackground(t *testing.T) {
	for _, tc := range []struct {
		name    string
		in      string
		lightBg bool
		want    string
	}{
		{
			name:    "ansi yellow with black on dark terminal",
			in:      "a\x1b[43;30myellow",
			lightBg: false,
			want:    "a\x1b[49;39myellow",
		},
		{
			name:    "ansi bright yellow with white on light terminal",
			in:      "a\x1b[103;37myellow",
			lightBg: true,
			want:    "a\x1b[49;39myellow",
		},
		{
			name:    "indexed yellow",
			in:      "a\x1b[48;5;11;30myellow",
			lightBg: false,
			want:    "a\x1b[49;39myellow",
		},
		{
			name:    "rgb yellow",
			in:      "a\x1b[48;2;246;226;183;30myellow",
			lightBg: false,
			want:    "a\x1b[49;39myellow",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := adaptOutputColors([]byte(tc.in), tc.lightBg)
			if string(out) != tc.want {
				t.Fatalf("out = %q, want %q", string(out), tc.want)
			}
		})
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

func TestConfiguredLightBackgroundOverride(t *testing.T) {
	t.Setenv("ORB_ATTACH_BACKGROUND", "light")
	light, ok := configuredLightBackground()
	if !ok || !light {
		t.Fatalf("configuredLightBackground() = %v, %v; want true, true", light, ok)
	}

	t.Setenv("ORB_ATTACH_BACKGROUND", "dark")
	light, ok = configuredLightBackground()
	if !ok || light {
		t.Fatalf("configuredLightBackground() = %v, %v; want false, true", light, ok)
	}
}

func TestColorFGBGLightBackground(t *testing.T) {
	for _, tc := range []struct {
		value string
		want  bool
	}{
		{value: "15;0", want: false},
		{value: "0;15", want: true},
		{value: "0;7", want: true},
		{value: "7;8", want: false},
	} {
		light, ok := colorFGBGLightBackground(tc.value)
		if !ok || light != tc.want {
			t.Fatalf("COLORFGBG %q = %v, %v; want %v, true", tc.value, light, ok, tc.want)
		}
	}
}

func TestColorFGBGLightBackgroundRejectsInvalidValue(t *testing.T) {
	for _, value := range []string{"", "x", "0;99"} {
		_, ok := colorFGBGLightBackground(value)
		if ok {
			t.Fatalf("COLORFGBG %q unexpectedly parsed", value)
		}
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
