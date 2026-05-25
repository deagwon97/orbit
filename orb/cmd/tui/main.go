package tui

import (
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"orb/internal/client"
	"orb/internal/ui"
)

func Execute() {
	c := client.New("http://127.0.0.1:7777")
	m := ui.New(c)
	if _, err := tea.NewProgram(m).Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
