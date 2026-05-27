package attach

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	clearScreenSeq     = "\x1b[2J\x1b[H"
	restoreTerminalSeq = "\x1b[<u\x1b[>4;0m\x1b[?25h\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[0m"
)

var detachTokens = [][]byte{
	{0x1D},                  // Ctrl-].
	{0x1C},                  // Ctrl-\.
	[]byte("\x1b[93;5u"),    // CSI-u Ctrl-].
	[]byte("\x1b[92;5u"),    // CSI-u Ctrl-\.
	[]byte("\x1b[27;5;93~"), // xterm modifyOtherKeys Ctrl-].
	[]byte("\x1b[27;5;92~"), // xterm modifyOtherKeys Ctrl-\.
}

var errDetached = errors.New("detached")
var errAttachClosed = errors.New("attach websocket closed")

type Command struct {
	URL   string
	Token string
	in    io.Reader
	out   io.Writer
	err   io.Writer
}

func New(url, token string) *Command {
	return &Command{URL: url, Token: token}
}

func (c *Command) SetStdin(r io.Reader)  { c.in = r }
func (c *Command) SetStdout(w io.Writer) { c.out = w }
func (c *Command) SetStderr(w io.Writer) { c.err = w }

func (c *Command) Run() error {
	if c.in == nil {
		c.in = os.Stdin
	}
	if c.out == nil {
		c.out = os.Stdout
	}
	if c.err == nil {
		c.err = os.Stderr
	}

	ws, err := dial(c.URL, c.Token)
	if err != nil {
		return err
	}
	defer ws.Close()
	if _, err := io.WriteString(c.out, clearScreenSeq); err != nil {
		return err
	}

	guard, err := enableRaw(c.in)
	if err == nil {
		defer guard.restore()
	}
	defer cleanupTerminal(c.in, c.out)

	lightBg := detectLightBackground(c.in, c.out)

	done := make(chan error, 2)
	var closeOnce sync.Once
	closeConn := func() { closeOnce.Do(func() { _ = ws.Close() }) }

	stopResize := startResizeLoop(ws, c.in)
	defer stopResize()

	go func() {
		err := copyInput(ws, c.in)
		if errors.Is(err, errDetached) {
			_ = ws.writeText(detachMessage())
			_ = ws.writeControl(0x8, nil)
			done <- err
			closeConn()
			return
		}
		reportInputError(c.err, err)
	}()
	go func() {
		done <- copyOutput(ws, c.out, lightBg)
		closeConn()
	}()

	err = <-done
	if errors.Is(err, errDetached) || err == nil {
		return nil
	}
	if err == io.EOF || strings.Contains(errString(err), "use of closed network connection") {
		return errAttachClosed
	}
	return err
}

func reportInputError(out io.Writer, err error) {
	if err == nil || errors.Is(err, io.EOF) {
		return
	}
	fmt.Fprintf(out, "\r\n[orb] stdin relay stopped: %v\r\n", err)
}

func cleanupTerminal(in io.Reader, out io.Writer) {
	_, _ = io.WriteString(out, restoreTerminalSeq)
	drainInputFor(in, 200*time.Millisecond)
	_, _ = io.WriteString(out, clearScreenSeq)
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

type rawGuard struct {
	file *os.File
	old  *unix.Termios
}

func enableRaw(r io.Reader) (*rawGuard, error) {
	file, ok := r.(*os.File)
	if !ok {
		file = os.Stdin
		if file == nil {
			return nil, fmt.Errorf("stdin is not a file")
		}
	}
	fd := int(file.Fd())
	old, err := getTermios(fd)
	if err != nil {
		return nil, err
	}
	raw := *old
	raw.Iflag &^= unix.BRKINT | unix.ICRNL | unix.INPCK | unix.ISTRIP | unix.IXON
	raw.Oflag &^= unix.OPOST
	raw.Cflag |= unix.CS8
	raw.Lflag &^= unix.ECHO | unix.ICANON | unix.IEXTEN | unix.ISIG
	raw.Cc[unix.VMIN] = 1
	raw.Cc[unix.VTIME] = 0
	if err := setTermios(fd, &raw); err != nil {
		return nil, err
	}
	return &rawGuard{file: file, old: old}, nil
}

func (g *rawGuard) restore() {
	_ = setTermios(int(g.file.Fd()), g.old)
}

type detachSeq struct {
	pending []byte
}

func (d *detachSeq) filter(in []byte) ([]byte, bool) {
	out := make([]byte, 0, len(in))
	for _, b := range in {
		d.pending = append(d.pending, b)
		for len(d.pending) > 0 && !hasDetachPrefix(d.pending) {
			out = append(out, d.pending[0])
			d.pending = d.pending[1:]
		}
		if isDetachToken(d.pending) {
			d.pending = nil
			return out, true
		}
	}
	return out, false
}

func hasDetachPrefix(in []byte) bool {
	for _, token := range detachTokens {
		if bytes.HasPrefix(token, in) {
			return true
		}
	}
	return false
}

func isDetachToken(in []byte) bool {
	for _, token := range detachTokens {
		if bytes.Equal(in, token) {
			return true
		}
	}
	return false
}

func (d *detachSeq) takePending() []byte {
	if len(d.pending) == 0 {
		return nil
	}
	pending := append([]byte(nil), d.pending...)
	d.pending = nil
	return pending
}

type stdinWriter interface {
	writeText([]byte) error
}

func copyInput(ws stdinWriter, in io.Reader) error {
	buf := make([]byte, 1024)
	detach := detachSeq{}
	for {
		n, err := in.Read(buf)
		if n > 0 {
			data, shouldDetach := detach.filter(buf[:n])
			if len(data) > 0 {
				if err := ws.writeText(stdinMessage(data)); err != nil {
					return err
				}
			}
			if shouldDetach {
				return errDetached
			}
		}
		if err != nil {
			if isRetryableInputError(err) {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			if pending := detach.takePending(); len(pending) > 0 {
				_ = ws.writeText(stdinMessage(pending))
			}
			return err
		}
	}
}

func isRetryableInputError(err error) bool {
	return errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EINTR)
}

func stdinMessage(data []byte) []byte {
	msg := map[string]string{
		"type": "stdin",
		"data": base64.StdEncoding.EncodeToString(data),
	}
	out, _ := json.Marshal(msg)
	return out
}

func detachMessage() []byte {
	msg := map[string]string{"type": "detach"}
	out, _ := json.Marshal(msg)
	return out
}

func replayLogs(rawURL, token string, out io.Writer) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	switch u.Scheme {
	case "ws":
		u.Scheme = "http"
	case "wss":
		u.Scheme = "https"
	}
	if !strings.HasSuffix(u.Path, "/attach") {
		return fmt.Errorf("attach URL does not end with /attach")
	}
	u.Path = strings.TrimSuffix(u.Path, "/attach") + "/logs"
	q := u.Query()
	q.Set("tail", "500")
	u.RawQuery = q.Encode()

	req, err := http.NewRequest(http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("logs request failed: %s", res.Status)
	}
	var response struct {
		Lines []struct {
			Content string `json:"content"`
		} `json:"lines"`
	}
	if err := json.NewDecoder(res.Body).Decode(&response); err != nil {
		return err
	}
	for _, line := range response.Lines {
		data, err := base64.StdEncoding.DecodeString(line.Content)
		if err != nil {
			return err
		}
		data = sanitizeReplay(data)
		if _, err := out.Write(data); err != nil {
			return err
		}
	}
	return nil
}

func sanitizeReplay(in []byte) []byte {
	out := make([]byte, 0, len(in))
	for i := 0; i < len(in); {
		if in[i] != 0x1b {
			out = append(out, in[i])
			i++
			continue
		}
		if i+1 >= len(in) {
			break
		}
		switch in[i+1] {
		case ']':
			i = skipStringTerminated(in, i+2)
		case 'P', '^', '_':
			i = skipStringTerminated(in, i+2)
		case '[':
			next, strip := scanCSI(in, i+2)
			if strip {
				i = next
			} else {
				out = append(out, in[i:next]...)
				i = next
			}
		default:
			out = append(out, in[i])
			i++
		}
	}
	return out
}

func skipStringTerminated(in []byte, i int) int {
	for i < len(in) {
		if in[i] == 0x07 {
			return i + 1
		}
		if in[i] == 0x1b && i+1 < len(in) && in[i+1] == '\\' {
			return i + 2
		}
		i++
	}
	return len(in)
}

func scanCSI(in []byte, i int) (int, bool) {
	start := i
	for i < len(in) {
		b := in[i]
		if b >= 0x40 && b <= 0x7e {
			params := in[start:i]
			strip := b == 'c' || b == 'n' || b == 'u' || (bytes.Contains(params, []byte("?")) && (b == 'p' || b == 'q'))
			return i + 1, strip
		}
		i++
	}
	return len(in), true
}

func drainInput(r io.Reader) {
	drainInputFor(r, 0)
}

func drainInputFor(r io.Reader, duration time.Duration) {
	file, ok := r.(*os.File)
	if !ok {
		return
	}
	fd := int(file.Fd())
	oldFlags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
	if err != nil {
		return
	}
	if err := unix.SetNonblock(fd, true); err != nil {
		return
	}
	defer func() { _, _ = unix.FcntlInt(uintptr(fd), unix.F_SETFL, oldFlags) }()

	deadline := time.Now().Add(duration)
	buf := make([]byte, 1024)
	for {
		n, err := file.Read(buf)
		if n == 0 && err == nil {
			return
		}
		if err != nil {
			if errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EWOULDBLOCK) {
				if duration <= 0 || time.Now().After(deadline) {
					return
				}
				time.Sleep(10 * time.Millisecond)
				continue
			}
			return
		}
	}
}

func startResizeLoop(ws stdinWriter, in io.Reader) func() {
	sendResize(ws, in)
	signals := make(chan os.Signal, 1)
	done := make(chan struct{})
	signal.Notify(signals, syscall.SIGWINCH)
	go func() {
		defer signal.Stop(signals)
		for {
			select {
			case <-signals:
				sendResize(ws, in)
			case <-done:
				return
			}
		}
	}()
	return func() { close(done) }
}

func sendResize(ws stdinWriter, in io.Reader) {
	file, ok := in.(*os.File)
	if !ok {
		file = os.Stdin
	}
	if file == nil {
		return
	}
	size, err := unix.IoctlGetWinsize(int(file.Fd()), unix.TIOCGWINSZ)
	if err != nil || size.Col == 0 || size.Row == 0 {
		return
	}
	msg := map[string]any{
		"type": "resize",
		"cols": size.Col,
		"rows": size.Row,
	}
	payload, _ := json.Marshal(msg)
	_ = ws.writeText(payload)
}

// detectLightBackground sends an OSC 11 terminal background color query and
// returns true if the terminal has a light background (relative luminance > 0.5).
// It must be called after enableRaw so the terminal echoes the response immediately.
// Returns false (dark) when the terminal does not respond within 200 ms.
func detectLightBackground(in io.Reader, out io.Writer) bool {
	file, ok := in.(*os.File)
	if !ok {
		file = os.Stdin
	}
	if file == nil {
		return false
	}
	fd := int(file.Fd())
	oldFlags, err := unix.FcntlInt(uintptr(fd), unix.F_GETFL, 0)
	if err != nil {
		return false
	}
	if _, err := io.WriteString(out, "\x1b]11;?\a"); err != nil {
		return false
	}
	if err := unix.SetNonblock(fd, true); err != nil {
		return false
	}
	defer func() { _, _ = unix.FcntlInt(uintptr(fd), unix.F_SETFL, oldFlags) }()

	deadline := time.Now().Add(200 * time.Millisecond)
	buf := make([]byte, 0, 64)
	tmp := make([]byte, 64)
	for time.Now().Before(deadline) {
		n, err := file.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			if lum, ok := parseOSC11Luminance(buf); ok {
				return lum > 0.5
			}
		}
		if err != nil {
			if errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EWOULDBLOCK) {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			break
		}
	}
	return false
}

// parseOSC11Luminance parses a terminal background color from an OSC 11 response
// (\x1b]11;rgb:RRRR/GGGG/BBBB\a) and returns the relative luminance (0–1).
func parseOSC11Luminance(data []byte) (float64, bool) {
	s := string(data)
	const prefix = "\x1b]11;rgb:"
	idx := strings.Index(s, prefix)
	if idx < 0 {
		return 0, false
	}
	s = s[idx+len(prefix):]
	end := strings.IndexAny(s, "\a\x1b")
	if end < 0 {
		return 0, false
	}
	s = s[:end]
	parts := strings.Split(s, "/")
	if len(parts) != 3 {
		return 0, false
	}
	r, err1 := strconv.ParseInt(parts[0], 16, 64)
	g, err2 := strconv.ParseInt(parts[1], 16, 64)
	b, err3 := strconv.ParseInt(parts[2], 16, 64)
	if err1 != nil || err2 != nil || err3 != nil {
		return 0, false
	}
	digits := len(parts[0])
	if digits == 0 {
		return 0, false
	}
	maxVal := float64(int64(1)<<(4*digits) - 1)
	rf := float64(r) / maxVal
	gf := float64(g) / maxVal
	bf := float64(b) / maxVal
	return 0.2126*rf + 0.7152*gf + 0.0722*bf, true
}

func copyOutput(ws *websocket, out io.Writer, lightBg bool) error {
	for {
		op, payload, err := ws.readFrame()
		if err != nil {
			return err
		}
		switch op {
		case 0x1:
			var msg struct {
				Type string `json:"type"`
				Data string `json:"data"`
			}
			if json.Unmarshal(payload, &msg) == nil && msg.Type == "stdout" {
				bytes, err := base64.StdEncoding.DecodeString(msg.Data)
				if err != nil {
					return err
				}
				bytes = adaptOutputColors(bytes, lightBg)
				if _, err := out.Write(bytes); err != nil {
					return err
				}
			}
		case 0x8:
			return errAttachClosed
		case 0x9:
			_ = ws.writeControl(0xA, payload)
		}
	}
}

func adaptOutputColors(in []byte, lightBg bool) []byte {
	out := make([]byte, 0, len(in))
	for i := 0; i < len(in); {
		if in[i] != 0x1b || i+1 >= len(in) || in[i+1] != '[' {
			out = append(out, in[i])
			i++
			continue
		}
		next, replacement, ok := rewriteSGR(in, i, lightBg)
		if !ok {
			out = append(out, in[i])
			i++
			continue
		}
		out = append(out, replacement...)
		i = next
	}
	return out
}

func rewriteSGR(in []byte, start int, lightBg bool) (int, []byte, bool) {
	i := start + 2
	for i < len(in) && in[i] != 'm' {
		if in[i] < '0' || in[i] > '9' {
			if in[i] != ';' {
				return start, nil, false
			}
		}
		i++
	}
	if i >= len(in) {
		return start, nil, false
	}
	params := string(in[start+2 : i])
	if params == "" {
		return i + 1, in[start : i+1], true
	}
	parts := strings.Split(params, ";")
	rewritten := make([]string, 0, len(parts))
	changed := false
	for p := 0; p < len(parts); p++ {
		value, err := strconv.Atoi(parts[p])
		if err != nil {
			return start, nil, false
		}
		switch {
		case value == 30 && !lightBg:
			// Dark terminal: black fg → default (black is invisible on dark bg).
			rewritten = append(rewritten, "39")
			changed = true
		case (value == 37 || value == 97) && lightBg:
			// Light terminal: white/bright-white fg → default (invisible on light bg).
			rewritten = append(rewritten, "39")
			changed = true
		case value == 38 && p+2 < len(parts) && parts[p+1] == "5":
			palIdx, _ := strconv.Atoi(parts[p+2])
			isBlack := palIdx == 0
			isWhite := palIdx == 7 || palIdx == 15
			if (!lightBg && isBlack) || (lightBg && isWhite) {
				rewritten = append(rewritten, "39")
				p += 2
				changed = true
			} else {
				rewritten = append(rewritten, parts[p])
			}
		case value == 38 && p+4 < len(parts) && parts[p+1] == "2":
			r, _ := strconv.Atoi(parts[p+2])
			g, _ := strconv.Atoi(parts[p+3])
			b, _ := strconv.Atoi(parts[p+4])
			isBlack := r == 0 && g == 0 && b == 0
			lum := (0.2126*float64(r) + 0.7152*float64(g) + 0.0722*float64(b)) / 255.0
			isNearWhite := lum > 0.7
			if (!lightBg && isBlack) || (lightBg && isNearWhite) {
				rewritten = append(rewritten, "39")
				p += 4
				changed = true
			} else {
				rewritten = append(rewritten, parts[p])
			}
		default:
			rewritten = append(rewritten, parts[p])
		}
	}
	if !changed {
		return i + 1, in[start : i+1], true
	}
	return i + 1, []byte("\x1b[" + strings.Join(rewritten, ";") + "m"), true
}

type websocket struct {
	conn net.Conn
	rw   *bufio.ReadWriter
	mu   sync.Mutex
}

func dial(rawURL, token string) (*websocket, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	host := u.Host
	address := host
	if !strings.Contains(host, ":") {
		if u.Scheme == "wss" {
			address += ":443"
		} else {
			address += ":80"
		}
	}
	var conn net.Conn
	if u.Scheme == "wss" {
		conn, err = tls.Dial("tcp", address, &tls.Config{ServerName: u.Hostname()})
	} else {
		conn, err = net.Dial("tcp", address)
	}
	if err != nil {
		return nil, err
	}

	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		_ = conn.Close()
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(keyBytes)
	path := u.RequestURI()
	if path == "" {
		path = "/"
	}
	req := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer %s\r\n\r\n", path, host, key, token)
	if _, err := io.WriteString(conn, req); err != nil {
		_ = conn.Close()
		return nil, err
	}
	rw := bufio.NewReadWriter(bufio.NewReader(conn), bufio.NewWriter(conn))
	res, err := http.ReadResponse(rw.Reader, &http.Request{Method: http.MethodGet})
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusSwitchingProtocols {
		_ = conn.Close()
		return nil, fmt.Errorf("websocket upgrade failed: %s", res.Status)
	}
	accept := res.Header.Get("Sec-WebSocket-Accept")
	if accept != websocketAccept(key) {
		_ = conn.Close()
		return nil, fmt.Errorf("websocket accept mismatch")
	}
	return &websocket{conn: conn, rw: rw}, nil
}

func websocketAccept(key string) string {
	h := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(h[:])
}

func (w *websocket) Close() error {
	return w.conn.Close()
}

func (w *websocket) writeText(payload []byte) error {
	return w.writeFrame(0x1, payload)
}

func (w *websocket) writeControl(op byte, payload []byte) error {
	return w.writeFrame(op, payload)
}

func (w *websocket) writeFrame(op byte, payload []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	header := []byte{0x80 | op}
	maskBit := byte(0x80)
	length := len(payload)
	switch {
	case length < 126:
		header = append(header, maskBit|byte(length))
	case length <= 65535:
		header = append(header, maskBit|126, byte(length>>8), byte(length))
	default:
		header = append(header, maskBit|127)
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], uint64(length))
		header = append(header, b[:]...)
	}
	mask := make([]byte, 4)
	if _, err := rand.Read(mask); err != nil {
		return err
	}
	masked := make([]byte, length)
	for i, b := range payload {
		masked[i] = b ^ mask[i%4]
	}
	if _, err := w.rw.Write(header); err != nil {
		return err
	}
	if _, err := w.rw.Write(mask); err != nil {
		return err
	}
	if _, err := w.rw.Write(masked); err != nil {
		return err
	}
	return w.rw.Flush()
}

func (w *websocket) readFrame() (byte, []byte, error) {
	first, err := w.rw.ReadByte()
	if err != nil {
		return 0, nil, err
	}
	second, err := w.rw.ReadByte()
	if err != nil {
		return 0, nil, err
	}
	op := first & 0x0F
	masked := second&0x80 != 0
	length := uint64(second & 0x7F)
	if length == 126 {
		var b [2]byte
		if _, err := io.ReadFull(w.rw, b[:]); err != nil {
			return 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(b[:]))
	} else if length == 127 {
		var b [8]byte
		if _, err := io.ReadFull(w.rw, b[:]); err != nil {
			return 0, nil, err
		}
		length = binary.BigEndian.Uint64(b[:])
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(w.rw, mask[:]); err != nil {
			return 0, nil, err
		}
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(w.rw, payload); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return op, payload, nil
}
