package models

import "os"

var TerminalEnvKeys = []string{
	"TERM",
	"COLORTERM",
	"COLORFGBG",
	"CLICOLOR",
	"CLICOLOR_FORCE",
	"FORCE_COLOR",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"KITTY_WINDOW_ID",
	"WEZTERM_EXECUTABLE",
	"VTE_VERSION",
	"KONSOLE_VERSION",
	"GNOME_TERMINAL_SCREEN",
	"ALACRITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"WT_SESSION",
	"ITERM_SESSION_ID",
	"LC_TERMINAL",
}

func WithTerminalEnv(env map[string]string) map[string]string {
	if env == nil {
		env = map[string]string{}
	}
	for _, key := range TerminalEnvKeys {
		if _, ok := env[key]; ok {
			continue
		}
		if value, ok := os.LookupEnv(key); ok && value != "" {
			env[key] = value
		}
	}
	if _, ok := env["COLORFGBG"]; !ok {
		env["COLORFGBG"] = "15;0"
	}
	return env
}
