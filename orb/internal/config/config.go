package config

import (
	"os"
	"path/filepath"
	"strings"
)

func Token() string {
	home, _ := os.UserHomeDir()
	data, _ := os.ReadFile(filepath.Join(home, ".config", "orbit", "token"))
	return strings.TrimSpace(string(data))
}
