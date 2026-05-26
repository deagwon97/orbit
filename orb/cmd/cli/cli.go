package cli

import (
	"bytes"
	"encoding/base64"
	"flag"
	"fmt"
	"os"
	"strings"

	attachcmd "orb/internal/attach"
	"orb/internal/client"
	"orb/internal/models"
)

const baseURL = "http://127.0.0.1:7777"

func Execute(args []string) error {
	if len(args) == 0 {
		usage()
		return nil
	}

	c := client.New(baseURL)
	switch args[0] {
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
		return fmt.Errorf("usage: orb run [--detach] [--name NAME] [--cwd DIR] [-e KEY=VALUE] <codex|claude-code|opencode|pi>")
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
	if len(args) != 1 {
		return fmt.Errorf("usage: orb rm <id|name>")
	}
	return c.DeleteSession(args[0])
}

func logs(c client.Client, args []string) error {
	fs := flag.NewFlagSet("logs", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	tail := fs.Int("tail", 0, "number of log chunks, 0 means all")
	raw := fs.Bool("raw", false, "print raw PTY output")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		return fmt.Errorf("usage: orb logs [--raw] [--tail N] <id|name>")
	}
	response, err := c.Logs(fs.Arg(0), *tail)
	if err != nil {
		return err
	}
	var out []byte
	for _, line := range response.Lines {
		data, err := base64.StdEncoding.DecodeString(line.Content)
		if err != nil {
			return err
		}
		out = append(out, data...)
	}
	if !*raw {
		out = sanitizeLogOutput(out)
	}
	if _, err := os.Stdout.Write(out); err != nil {
		return err
	}
	return nil
}

func sanitizeLogOutput(in []byte) []byte {
	out := make([]byte, 0, len(in))
	for i := 0; i < len(in); {
		switch in[i] {
		case 0x1b:
			i = skipEscapeSequence(in, i)
		case '\r':
			if i+1 < len(in) && in[i+1] == '\n' {
				out = appendNewline(out)
				i += 2
			} else {
				out = appendNewline(out)
				i++
			}
		case '\b':
			if len(out) > 0 && out[len(out)-1] != '\n' {
				out = out[:len(out)-1]
			}
			i++
		default:
			out = append(out, in[i])
			i++
		}
	}
	return compactBlankLines(out)
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
  orb ps [-a|--all]    list sessions
  orb run [opts] <tool> create a session and attach
  orb attach <id|name> attach to a session (detach: Ctrl-] or Ctrl-\)
  orb rm <id|name>     remove a session
  orb logs [opts] <id>  print session logs

tools: codex, claude-code, opencode, pi
`
}
