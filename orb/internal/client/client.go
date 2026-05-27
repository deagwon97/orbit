package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"orb/internal/config"
	"orb/internal/models"
)

type Client struct {
	Base  string
	Token string
}

func New(base string) Client {
	return Client{Base: strings.TrimRight(base, "/"), Token: config.Token()}
}

func (c Client) request(method, path string, query url.Values, body any) (*http.Response, error) {
	var r io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		r = bytes.NewReader(data)
	}
	u := c.Base + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	req, err := http.NewRequest(method, u, r)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		defer res.Body.Close()
		data, _ := io.ReadAll(res.Body)
		return nil, fmt.Errorf("%s %s: %s", method, path, strings.TrimSpace(string(data)))
	}
	return res, nil
}

func (c Client) Sessions(all bool) ([]models.Session, error) {
	q := url.Values{}
	if !all {
		q.Set("status", "running")
	}
	res, err := c.request(http.MethodGet, "/api/v1/sessions", q, nil)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var sessions []models.Session
	return sessions, json.NewDecoder(res.Body).Decode(&sessions)
}

func (c Client) Backends() ([]models.AgentBackend, error) {
	res, err := c.request(http.MethodGet, "/api/v1/backends", nil, nil)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var backends []models.AgentBackend
	return backends, json.NewDecoder(res.Body).Decode(&backends)
}

func (c Client) CreateSession(req models.CreateSessionRequest) (models.Session, error) {
	res, err := c.request(http.MethodPost, "/api/v1/sessions", nil, req)
	if err != nil {
		return models.Session{}, err
	}
	defer res.Body.Close()
	var session models.Session
	return session, json.NewDecoder(res.Body).Decode(&session)
}

func (c Client) DeleteSession(id string) error {
	res, err := c.request(http.MethodDelete, "/api/v1/sessions/"+url.PathEscape(id), nil, nil)
	if err != nil {
		return err
	}
	return res.Body.Close()
}

func (c Client) Logs(id string, tail int) (models.LogsResponse, error) {
	q := url.Values{"tail": []string{fmt.Sprintf("%d", tail)}}
	res, err := c.request(http.MethodGet, "/api/v1/sessions/"+url.PathEscape(id)+"/logs", q, nil)
	if err != nil {
		return models.LogsResponse{}, err
	}
	defer res.Body.Close()
	var logs models.LogsResponse
	return logs, json.NewDecoder(res.Body).Decode(&logs)
}

func (c Client) AttachURL(id string) string {
	base := strings.TrimRight(c.Base, "/")
	base = strings.Replace(base, "http://", "ws://", 1)
	base = strings.Replace(base, "https://", "wss://", 1)
	return base + "/api/v1/sessions/" + url.PathEscape(id) + "/attach"
}
