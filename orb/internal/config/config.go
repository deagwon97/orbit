package config

import (
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

const DefaultURL = "http://127.0.0.1:7777"

type fileConfig struct {
	URL string `yaml:"url"`
}

// Path returns the orb config file path.
// Default: ~/.config/orbit/orb/config.yaml. Override via ORB_CONFIG.
func Path() string {
	if p := strings.TrimSpace(os.Getenv("ORB_CONFIG")); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "orbit", "orb", "config.yaml")
}

// TokenPath returns the orb token file path.
// Default: ~/.config/orbit/orb/token. Override via ORB_TOKEN_PATH.
func TokenPath() string {
	if p := strings.TrimSpace(os.Getenv("ORB_TOKEN_PATH")); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "orbit", "orb", "token")
}

func Token() string {
	path := TokenPath()
	if path == "" {
		return ""
	}
	data, _ := os.ReadFile(path)
	return strings.TrimSpace(string(data))
}

// URL returns the orbitd base URL from the config file, falling back to
// DefaultURL when the file or field is missing.
func URL() string {
	path := Path()
	if path == "" {
		return DefaultURL
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return DefaultURL
	}
	var cfg fileConfig
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return DefaultURL
	}
	if url := strings.TrimSpace(cfg.URL); url != "" {
		return url
	}
	return DefaultURL
}
