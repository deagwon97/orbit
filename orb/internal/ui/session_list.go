package ui

import (
	"encoding/base64"
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"orb/internal/attach"
	"orb/internal/client"
	"orb/internal/models"
)

type mode int

const (
	modeList mode = iota
	modeCreate
	modeLogs
)

var tools = []string{"codex", "claude", "opencode", "pi"}

type Model struct {
	client   client.Client
	sessions []models.Session
	cursor   int
	all      bool
	mode     mode
	err      error
	status   string
	form     createForm
	logs     string
}

type createForm struct {
	cursor int
	tool   int
	name   string
	cwd    string
	env    string
	detach bool
}

type sessionsMsg []models.Session
type errMsg error
type statusMsg string
type createdMsg struct{ session models.Session }
type deletedMsg string
type logsMsg string
type attachDoneMsg struct{ err error }

func New(c client.Client) Model {
	return Model{
		client: c,
		form:   createForm{detach: true},
	}
}

func (m Model) Init() tea.Cmd {
	return m.load
}

func (m Model) load() tea.Msg {
	sessions, err := m.client.Sessions(m.all)
	if err != nil {
		return errMsg(err)
	}
	return sessionsMsg(sessions)
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case sessionsMsg:
		m.sessions = msg
		if m.cursor >= len(m.sessions) {
			m.cursor = max(0, len(m.sessions)-1)
		}
		m.err = nil
	case errMsg:
		m.err = msg
	case statusMsg:
		m.status = string(msg)
	case createdMsg:
		m.mode = modeList
		m.status = fmt.Sprintf("created %s %s %s", msg.session.ID, msg.session.Name, msg.session.Status)
		m.form = createForm{detach: true}
		return m, m.load
	case attachAfterCreateMsg:
		m.mode = modeList
		m.status = fmt.Sprintf("created %s %s %s", msg.session.ID, msg.session.Name, msg.session.Status)
		m.form = createForm{detach: true}
		return m, m.attachCmd(msg.session.ID)
	case deletedMsg:
		m.status = "removed " + string(msg)
		return m, m.load
	case logsMsg:
		m.logs = string(msg)
		m.mode = modeLogs
	case attachDoneMsg:
		if msg.err != nil {
			m.err = msg.err
		} else {
			m.status = "detached"
		}
		return m, m.load
	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch m.mode {
	case modeCreate:
		return m.handleCreateKey(msg)
	case modeLogs:
		switch msg.String() {
		case "q", "esc", "enter", "l":
			m.mode = modeList
		}
		return m, nil
	}

	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "r":
		return m, m.load
	case "tab":
		m.all = !m.all
		m.status = ""
		return m, m.load
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(m.sessions)-1 {
			m.cursor++
		}
	case "n":
		m.mode = modeCreate
		m.err = nil
	case "enter", "a":
		if s, ok := m.selected(); ok {
			return m, m.attachCmd(s.ID)
		}
	case "x":
		if s, ok := m.selected(); ok {
			return m, func() tea.Msg {
				if err := m.client.DeleteSession(s.ID); err != nil {
					return errMsg(err)
				}
				return deletedMsg(s.ID)
			}
		}
	case "l":
		if s, ok := m.selected(); ok {
			return m, m.logsCmd(s.ID, 100)
		}
	}
	return m, nil
}

func (m Model) handleCreateKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "ctrl+c":
		m.mode = modeList
		return m, nil
	case "tab", "down", "enter":
		if msg.String() == "enter" && m.form.cursor == 5 {
			return m, m.createCmd()
		}
		m.form.cursor = (m.form.cursor + 1) % 6
		return m, nil
	case "shift+tab", "up":
		m.form.cursor = (m.form.cursor + 5) % 6
		return m, nil
	case "left":
		if m.form.cursor == 0 {
			m.form.tool = (m.form.tool + len(tools) - 1) % len(tools)
		} else if m.form.cursor == 4 {
			m.form.detach = !m.form.detach
		}
		return m, nil
	case "right":
		if m.form.cursor == 0 {
			m.form.tool = (m.form.tool + 1) % len(tools)
		} else if m.form.cursor == 4 {
			m.form.detach = !m.form.detach
		}
		return m, nil
	case "backspace", "ctrl+h":
		m.form.backspace()
		return m, nil
	case " ":
		if m.form.cursor == 4 {
			m.form.detach = !m.form.detach
		} else {
			m.form.insert(" ")
		}
		return m, nil
	}
	if len(msg.Runes) > 0 {
		m.form.insert(string(msg.Runes))
	}
	return m, nil
}

func (f *createForm) insert(s string) {
	switch f.cursor {
	case 1:
		f.name += s
	case 2:
		f.cwd += s
	case 3:
		f.env += s
	}
}

func (f *createForm) backspace() {
	trim := func(s string) string {
		r := []rune(s)
		if len(r) == 0 {
			return s
		}
		return string(r[:len(r)-1])
	}
	switch f.cursor {
	case 1:
		f.name = trim(f.name)
	case 2:
		f.cwd = trim(f.cwd)
	case 3:
		f.env = trim(f.env)
	}
}

func (m Model) createCmd() tea.Cmd {
	form := m.form
	return func() tea.Msg {
		req := models.CreateSessionRequest{
			Tool: tools[form.tool],
			Env:  models.WithTerminalEnv(parseEnv(form.env)),
		}
		if strings.TrimSpace(form.name) != "" {
			name := strings.TrimSpace(form.name)
			req.Name = &name
		}
		if strings.TrimSpace(form.cwd) != "" {
			cwd := strings.TrimSpace(form.cwd)
			req.CWD = &cwd
		}
		session, err := m.client.CreateSession(req)
		if err != nil {
			return errMsg(err)
		}
		if !form.detach {
			return attachAfterCreateMsg{session: session}
		}
		return createdMsg{session: session}
	}
}

type attachAfterCreateMsg struct{ session models.Session }

func (m Model) attachCmd(id string) tea.Cmd {
	cmd := attach.New(m.client.AttachURL(id), m.client.Token)
	return tea.Exec(cmd, func(err error) tea.Msg {
		return attachDoneMsg{err: err}
	})
}

func (m Model) logsCmd(id string, tail int) tea.Cmd {
	return func() tea.Msg {
		logs, err := m.client.Logs(id, tail)
		if err != nil {
			return errMsg(err)
		}
		var b strings.Builder
		for _, line := range logs.Lines {
			bytes, err := base64.StdEncoding.DecodeString(line.Content)
			if err != nil {
				return errMsg(err)
			}
			b.Write(bytes)
		}
		return logsMsg(b.String())
	}
}

func parseEnv(input string) map[string]string {
	env := map[string]string{}
	for _, part := range strings.Fields(input) {
		key, value, ok := strings.Cut(part, "=")
		if ok && key != "" {
			env[key] = value
		}
	}
	return env
}

func (m Model) selected() (models.Session, bool) {
	if len(m.sessions) == 0 || m.cursor < 0 || m.cursor >= len(m.sessions) {
		return models.Session{}, false
	}
	return m.sessions[m.cursor], true
}

func (m Model) View() string {
	switch m.mode {
	case modeCreate:
		return m.createView()
	case modeLogs:
		return m.logsView()
	default:
		return m.listView()
	}
}

func (m Model) listView() string {
	title := lipgloss.NewStyle().Bold(true).Render("Orbit Sessions")
	filter := "running"
	if m.all {
		filter = "all"
	}
	var b strings.Builder
	b.WriteString(title + "  " + lipgloss.NewStyle().Faint(true).Render(filter) + "\n\n")
	if m.err != nil {
		b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color("9")).Render(m.err.Error()) + "\n\n")
	} else if m.status != "" {
		b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color("10")).Render(m.status) + "\n\n")
	}
	b.WriteString(fmt.Sprintf("%-1s %-12s %-24s %-12s %-10s %-8s %s\n", "", "ID", "NAME", "TOOL", "STATUS", "PID", "CWD"))
	for i, s := range m.sessions {
		prefix := " "
		if i == m.cursor {
			prefix = ">"
		}
		pid := "-"
		if s.PID != nil {
			pid = fmt.Sprintf("%d", *s.PID)
		}
		b.WriteString(fmt.Sprintf("%s %-12s %-24s %-12s %-10s %-8s %s\n", prefix, s.ID, truncate(s.Name, 24), s.Tool, s.Status, pid, s.CWD))
	}
	b.WriteString("\nenter/a attach | n run | x rm | l logs | tab filter | r refresh | q quit\n")
	return b.String()
}

func (m Model) createView() string {
	labels := []string{"tool", "name", "cwd", "env", "detach", "create"}
	values := []string{tools[m.form.tool], m.form.name, m.form.cwd, m.form.env, fmt.Sprintf("%t", m.form.detach), "press enter"}
	var b strings.Builder
	b.WriteString(lipgloss.NewStyle().Bold(true).Render("Run Session") + "\n\n")
	if m.err != nil {
		b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color("9")).Render(m.err.Error()) + "\n\n")
	}
	for i := range labels {
		prefix := " "
		if i == m.form.cursor {
			prefix = ">"
		}
		b.WriteString(fmt.Sprintf("%s %-8s %s\n", prefix, labels[i], values[i]))
	}
	b.WriteString("\narrow/tab move | type edit | space toggle | enter create | esc cancel\n")
	return b.String()
}

func (m Model) logsView() string {
	var b strings.Builder
	b.WriteString(lipgloss.NewStyle().Bold(true).Render("Session Logs") + "\n\n")
	lines := strings.Split(m.logs, "\n")
	if len(lines) > 40 {
		lines = lines[len(lines)-40:]
	}
	b.WriteString(strings.Join(lines, "\n"))
	b.WriteString("\n\nesc/enter/l back\n")
	return b.String()
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

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
