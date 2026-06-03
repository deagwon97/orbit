package cli

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	attachcmd "orb/internal/attach"
	"orb/internal/client"
	"orb/internal/config"
	"orb/internal/models"
)

func Execute(args []string) error {
	if len(args) == 0 {
		usage()
		return nil
	}

	c := client.New(config.URL())
	switch args[0] {
	case "backends", "tools":
		return backends(c, args[1:])
	case "ps", "list":
		return ps(c, args[1:])
	case "run":
		return run(c, args[1:])
	case "attach", "a":
		return attach(c, args[1:])
	case "rm", "delete":
		return remove(c, args[1:])
	case "logs":
		return logs(c, args[1:])
	case "help", "-h", "--help":
		usage()
		return nil
	default:
		return fmt.Errorf("unknown command %q\n\n%s", args[0], usageText())
	}
}

func ps(c client.Client, args []string) error {
	fs := flag.NewFlagSet("ps", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	all := fs.Bool("all", false, "show all sessions")
	fs.BoolVar(all, "a", false, "show all sessions (shorthand)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	sessions, err := c.Sessions(*all)
	if err != nil {
		return err
	}
	printSessions(sessions)
	return nil
}

func backends(c client.Client, args []string) error {
	if len(args) != 0 {
		return fmt.Errorf("usage: orb backends")
	}
	items, err := c.Backends()
	if err != nil {
		return err
	}
	fmt.Printf("%-16s %-20s %-24s %s\n", "ID", "NAME", "COMMAND", "ARGS")
	for _, item := range items {
		fmt.Printf("%-16s %-20s %-24s %s\n",
			item.ID,
			truncate(item.Name, 20),
			truncate(item.Command, 24),
			strings.Join(item.Args, " "),
		)
	}
	return nil
}

func run(c client.Client, args []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	name := fs.String("name", "", "session name")
	cwd := fs.String("cwd", "", "working directory")
	detach := fs.Bool("detach", false, "create the session without attaching")
	envValues := multiFlag{}
	fs.Var(&envValues, "e", "environment variable KEY=VALUE")
	fs.Var(&envValues, "env", "environment variable KEY=VALUE")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("usage: orb run [--detach] [--name NAME] [--cwd DIR] [-e KEY=VALUE] <backend>")
	}

	req := models.CreateSessionRequest{
		Tool: fs.Arg(0),
		Env:  models.WithTerminalEnv(parseEnv(envValues)),
	}
	if strings.TrimSpace(*name) != "" {
		value := strings.TrimSpace(*name)
		req.Name = &value
	}
	if strings.TrimSpace(*cwd) != "" {
		value := strings.TrimSpace(*cwd)
		req.CWD = &value
	} else if value, err := os.Getwd(); err == nil {
		req.CWD = &value
	}

	session, err := c.CreateSession(req)
	if err != nil {
		return err
	}
	if !*detach {
		return attachcmd.New(c.AttachURL(session.ID), c.Token).Run()
	}
	printSessions([]models.Session{session})
	return nil
}

func attach(c client.Client, args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: orb attach <id|name>")
	}
	return attachcmd.New(c.AttachURL(args[0]), c.Token).Run()
}

func remove(c client.Client, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: orb rm <id|name> [id|name...]")
	}
	for _, id := range args {
		if err := c.DeleteSession(id); err != nil {
			return fmt.Errorf("remove %s: %w", id, err)
		}
	}
	return nil
}

func logs(c client.Client, args []string) error {
	fs := flag.NewFlagSet("logs", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	tail := fs.Int("tail", -1, "number of log chunks, 0 means all")
	pageSize := fs.Int("page-size", 200, "number of log chunks per page")
	raw := fs.Bool("raw", false, "print raw PTY output")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("usage: orb logs [--raw] [--tail N] [--page-size N] <id|name>")
	}
	if *tail >= 0 {
		response, err := c.Logs(fs.Arg(0), *tail)
		if err != nil {
			return err
		}
		return writeLogLines(os.Stdout, response.Lines, *raw)
	}

	var after int64
	var until *int64
	reader := bufio.NewReader(os.Stdin)
	interactive := isTerminal(os.Stdin)
	for {
		response, err := c.LogsPage(fs.Arg(0), after, *pageSize, until)
		if err != nil {
			return err
		}
		if until == nil {
			until = response.SnapshotLastID
		}
		if err := writeLogLines(os.Stdout, response.Lines, *raw); err != nil {
			return err
		}
		if response.NextAfter != nil {
			after = *response.NextAfter
		}
		if !response.HasMore || response.NextAfter == nil {
			return nil
		}
		if !interactive {
			continue
		}
		fmt.Fprint(os.Stderr, "\n-- More -- Enter: next page, q: quit ")
		line, err := reader.ReadString('\n')
		if err != nil && err != io.EOF {
			return err
		}
		if strings.EqualFold(strings.TrimSpace(line), "q") {
			return nil
		}
	}
}

func writeLogLines(w io.Writer, lines []models.LogLine, raw bool) error {
	var out []byte
	for _, line := range lines {
		data, err := base64.StdEncoding.DecodeString(line.Content)
		if err != nil {
			return err
		}
		out = append(out, data...)
	}
	if !raw {
		out = sanitizeLogOutput(out)
	}
	_, err := w.Write(out)
	return err
}

func isTerminal(file *os.File) bool {
	info, err := file.Stat()
	return err == nil && (info.Mode()&os.ModeCharDevice) != 0
}

func sanitizeLogOutput(in []byte) []byte {
	// Simple terminal emulation: process ANSI sequences to render final output
	buf := newTerminalBuffer(80, 24)
	buf.write(in)
	return buf.render()
}

// terminalBuffer is a simple ANSI terminal emulator
type terminalBuffer struct {
	width    int
	height   int
	screen   [][]byte
	x, y     int
	scrollTop, scrollBottom int
}

func newTerminalBuffer(width, height int) *terminalBuffer {
	screen := make([][]byte, height)
	for i := range screen {
		screen[i] = make([]byte, 0, width)
	}
	return &terminalBuffer{
		width:  width,
		height: height,
		screen: screen,
		x:      0,
		y:      0,
		scrollTop: 0,
		scrollBottom: height - 1,
	}
}

func (t *terminalBuffer) write(data []byte) {
	i := 0
	for i < len(data) {
		switch data[i] {
		case 0x1b:
			i = t.parseEscape(data, i)
		case '\n':
			t.newline()
			i++
		case '\r':
			t.carriageReturn()
			i++
		case '\b':
			t.backspace()
			i++
		case '\t':
			t.tab()
			i++
		default:
			if data[i] >= 0x20 && data[i] < 0x7f {
				t.putChar(data[i])
			}
			i++
		}
	}
}

func (t *terminalBuffer) parseEscape(data []byte, i int) int {
	if i+1 >= len(data) {
		return len(data)
	}
	switch data[i+1] {
	case '[':
		return t.parseCSI(data, i+2)
	case ']':
		return t.skipUntil(data, i+2, 0x07)
	default:
		return i + 2
	}
}

func (t *terminalBuffer) parseCSI(data []byte, i int) int {
	// Parse optional parameters
	params := make([]int, 0, 4)
	num := 0
	hasNum := false
	for i < len(data) {
		b := data[i]
		if b >= '0' && b <= '9' {
			num = num*10 + int(b-'0')
			hasNum = true
			i++
		} else if b == ';' {
			if hasNum {
				params = append(params, num)
			} else {
				params = append(params, 0)
			}
			num = 0
			hasNum = false
			i++
		} else if b >= '@' && b <= '~' {
			// Command
			if hasNum {
				params = append(params, num)
			}
			t.execCSI(b, params)
			return i + 1
		} else {
			i++
		}
	}
	return len(data)
}

func (t *terminalBuffer) execCSI(cmd byte, params []int) {
	switch cmd {
	case 'A': // Cursor Up
		n := 1
		if len(params) > 0 && params[0] > 0 {
			n = params[0]
		}
		t.y = max(0, t.y-n)
	case 'B': // Cursor Down
		n := 1
		if len(params) > 0 && params[0] > 0 {
			n = params[0]
		}
		t.y = min(t.height-1, t.y+n)
	case 'C': // Cursor Forward
		n := 1
		if len(params) > 0 && params[0] > 0 {
			n = params[0]
		}
		t.x = min(t.width-1, t.x+n)
	case 'D': // Cursor Back
		n := 1
		if len(params) > 0 && params[0] > 0 {
			n = params[0]
		}
		t.x = max(0, t.x-n)
	case 'E': // Cursor Next Line
		n := 1
		if len(params) > 0 && params[0] > 0 {
			n = params[0]
		}
		t.y = min(t.height-1, t.y+n)
		t.x = 0
	case 'F': // Cursor Previous Line
		n := 1
		if len(params) > 0 && params[0] > 0 {
			n = params[0]
		}
		t.y = max(0, t.y-n)
		t.x = 0
	case 'G': // Cursor Horizontal Absolute
		n := 1
		if len(params) > 0 && params[0] > 0 {
			n = params[0]
		}
		t.x = min(t.width-1, n-1)
	case 'H', 'f': // Cursor Position
		row, col := 1, 1
		if len(params) >= 1 && params[0] > 0 {
			row = params[0]
		}
		if len(params) >= 2 && params[1] > 0 {
			col = params[1]
		}
		t.y = max(0, min(t.height-1, row-1))
		t.x = max(0, min(t.width-1, col-1))
	case 'J': // Erase Display
		if len(params) == 0 || params[0] == 0 {
			// Clear from cursor to end of screen
			for x := t.x; x < t.width; x++ {
				t.set(t.x, t.y, ' ')
			}
			for y := t.y + 1; y < t.height; y++ {
				for x := 0; x < t.width; x++ {
					t.set(x, y, ' ')
				}
			}
		}
	case 'K': // Erase Line
		if len(params) == 0 || params[0] == 0 {
			// Clear from cursor to end of line
			for x := t.x; x < t.width; x++ {
				t.set(t.x, t.y, ' ')
			}
		}
	case 'm': // SGR (ignored for rendering)
	case 'l', 'h': // Show/hide cursor (ignored)
	}
}

func (t *terminalBuffer) putChar(b byte) {
	if t.x >= t.width {
		t.newline()
	}
	if t.x < t.width {
		t.set(t.x, t.y, b)
		t.x++
	}
}

func (t *terminalBuffer) set(x, y int, b byte) {
	if y < 0 || y >= t.height || x < 0 || x >= t.width {
		return
	}
	// Extend row if needed
	for len(t.screen[y]) <= x {
		t.screen[y] = append(t.screen[y], ' ')
	}
	t.screen[y][x] = b
}

func (t *terminalBuffer) newline() {
	t.x = 0
	t.y++
	if t.y > t.scrollBottom {
		// Scroll up
		t.screen = append(t.screen[1:], make([]byte, 0, t.width))
		t.y = t.scrollBottom
	}
}

func (t *terminalBuffer) carriageReturn() {
	t.x = 0
}

func (t *terminalBuffer) backspace() {
	if t.x > 0 {
		t.x--
	}
}

func (t *terminalBuffer) tab() {
	tabStop := 8
	nextTab := ((t.x / tabStop) + 1) * tabStop
	for t.x < nextTab && t.x < t.width {
		t.putChar(' ')
	}
}

func (t *terminalBuffer) skipUntil(data []byte, i int, term byte) int {
	for i < len(data) {
		if data[i] == term {
			return i + 1
		}
		i++
	}
	return len(data)
}

func (t *terminalBuffer) render() []byte {
	var out []byte
	for y := 0; y < t.height; y++ {
		row := t.screen[y]
		if len(row) > 0 {
			// Trim trailing spaces
			end := len(row)
			for end > 0 && row[end-1] == ' ' {
				end--
			}
			out = append(out, row[:end]...)
		}
		out = append(out, '\n')
	}
	// Trim trailing blank lines
	for len(out) > 0 && out[len(out)-1] == '\n' {
		if len(out) > 1 && out[len(out)-2] == '\n' {
			out = out[:len(out)-1]
		} else {
			break
		}
	}
	return out
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func appendNewline(out []byte) []byte {
	if len(out) == 0 || out[len(out)-1] == '\n' {
		return out
	}
	return append(out, '\n')
}

func compactBlankLines(in []byte) []byte {
	out := make([]byte, 0, len(in))
	newlines := 0
	for _, b := range bytes.TrimRight(in, " \t\n") {
		if b == '\n' {
			newlines++
			if newlines <= 2 {
				out = append(out, b)
			}
			continue
		}
		if b != ' ' && b != '\t' {
			newlines = 0
		}
		out = append(out, b)
	}
	if len(out) > 0 {
		out = append(out, '\n')
	}
	return out
}

func skipEscapeSequence(in []byte, i int) int {
	if i+1 >= len(in) {
		return len(in)
	}
	switch in[i+1] {
	case '[':
		return skipCSI(in, i+2)
	case ']':
		return skipStringTerminated(in, i+2)
	case 'P', '^', '_':
		return skipStringTerminated(in, i+2)
	default:
		if in[i+1] >= 0x40 && in[i+1] <= 0x5f {
			return i + 2
		}
		return i + 1
	}
}

func skipCSI(in []byte, i int) int {
	for i < len(in) {
		if in[i] >= 0x40 && in[i] <= 0x7e {
			return i + 1
		}
		i++
	}
	return len(in)
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

func printSessions(sessions []models.Session) {
	fmt.Printf("%-12s %-24s %-12s %-10s %-8s %s\n", "ID", "NAME", "TOOL", "STATUS", "PID", "CWD")
	for _, session := range sessions {
		pid := "-"
		if session.PID != nil {
			pid = fmt.Sprintf("%d", *session.PID)
		}
		fmt.Printf("%-12s %-24s %-12s %-10s %-8s %s\n",
			session.ID,
			truncate(session.Name, 24),
			session.Tool,
			session.Status,
			pid,
			session.CWD,
		)
	}
}

func parseEnv(values []string) map[string]string {
	env := map[string]string{}
	for _, value := range values {
		key, val, ok := strings.Cut(value, "=")
		if ok && key != "" {
			env[key] = val
		}
	}
	return env
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	if n <= 3 {
		return string(r[:n])
	}
	return string(r[:n-3]) + "..."
}

type multiFlag []string

func (m *multiFlag) String() string {
	return strings.Join(*m, ",")
}

func (m *multiFlag) Set(value string) error {
	*m = append(*m, value)
	return nil
}

func usage() {
	fmt.Print(usageText())
}

func usageText() string {
	return `usage:
  orb                  open TUI
  orb backends         list available agent backends
  orb ps [-a|--all]    list sessions
  orb run [opts] <backend> create a session and attach
  orb attach <id|name> attach to a session (detach: Ctrl-] or Ctrl-\)
  orb rm <id|name>...   remove sessions
  orb logs [opts] <id>  print session logs

tools are provided by orbitd: run "orb backends"
`
}
