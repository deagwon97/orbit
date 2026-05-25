package models

import "time"

type Session struct {
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	Tool           string     `json:"tool"`
	Status         string     `json:"status"`
	PID            *int       `json:"pid"`
	CWD            string     `json:"cwd"`
	CreatedAt      time.Time  `json:"created_at"`
	LastAttachedAt *time.Time `json:"last_attached_at"`
	ExitCode       *int       `json:"exit_code"`
}

type CreateSessionRequest struct {
	Tool string            `json:"tool"`
	Name *string           `json:"name,omitempty"`
	CWD  *string           `json:"cwd,omitempty"`
	Env  map[string]string `json:"env"`
}

type LogsResponse struct {
	Lines []LogLine `json:"lines"`
}

type LogLine struct {
	Timestamp time.Time `json:"timestamp"`
	Content   string    `json:"content"`
}
