package models

import "testing"

func TestWithTerminalEnvAddsPresentValues(t *testing.T) {
	t.Setenv("TERM", "xterm-kitty")
	t.Setenv("COLORTERM", "truecolor")
	t.Setenv("COLORFGBG", "15;0")

	env := WithTerminalEnv(map[string]string{})
	if env["TERM"] != "xterm-kitty" {
		t.Fatalf("TERM = %q", env["TERM"])
	}
	if env["COLORTERM"] != "truecolor" {
		t.Fatalf("COLORTERM = %q", env["COLORTERM"])
	}
	if env["COLORFGBG"] != "15;0" {
		t.Fatalf("COLORFGBG = %q", env["COLORFGBG"])
	}
}

func TestWithTerminalEnvPreservesExplicitValues(t *testing.T) {
	t.Setenv("TERM", "xterm-kitty")

	env := WithTerminalEnv(map[string]string{"TERM": "vt100"})
	if env["TERM"] != "vt100" {
		t.Fatalf("TERM = %q, want explicit value", env["TERM"])
	}
}

func TestWithTerminalEnvSkipsEmptyValues(t *testing.T) {
	t.Setenv("COLORTERM", "")

	env := WithTerminalEnv(map[string]string{})
	if _, ok := env["COLORTERM"]; ok {
		t.Fatal("empty COLORTERM should not be forwarded")
	}
}

func TestWithTerminalEnvDoesNotAutoForwardNoColor(t *testing.T) {
	t.Setenv("NO_COLOR", "1")

	env := WithTerminalEnv(map[string]string{})
	if _, ok := env["NO_COLOR"]; ok {
		t.Fatal("NO_COLOR should only be forwarded when explicitly set in request env")
	}
}

func TestWithTerminalEnvDefaultsColorFGBGToDarkBackground(t *testing.T) {
	env := WithTerminalEnv(map[string]string{})
	if env["COLORFGBG"] != "15;0" {
		t.Fatalf("COLORFGBG = %q, want dark background default", env["COLORFGBG"])
	}
}

func TestWithTerminalEnvPreservesExplicitColorFGBG(t *testing.T) {
	env := WithTerminalEnv(map[string]string{"COLORFGBG": "0;15"})
	if env["COLORFGBG"] != "0;15" {
		t.Fatalf("COLORFGBG = %q, want explicit value", env["COLORFGBG"])
	}
}
