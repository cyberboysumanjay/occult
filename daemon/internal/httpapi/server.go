// Package httpapi serves the read-only dashboard and JSON API for occultd.
//
// Routes:
//
//	GET    /api/profile               the configured user (dashboard header)
//	GET    /api/settings              full editable settings document
//	POST   /api/settings              save settings (onboarding + settings panel)
//	POST   /api/telegram/test         send a test message with given/saved creds
//	GET    /api/latest                the most-recent reading, or {} if none
//	GET    /api/readings[?since=ISO]   all readings oldest→newest
//	DELETE /api/readings/{id}          remove one reading
//	GET    /*                         static dashboard assets (embedded)
//
// Reading ingestion is BLE-only; the dashboard can edit settings and delete
// stray readings.
package httpapi

import (
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"strconv"
	"time"

	"occultd/internal/settings"
	"occultd/internal/store"
	"occultd/internal/telegram"
)

// Server bundles the dependencies the handlers need.
type Server struct {
	store *store.Store
	web   fs.FS
}

// New builds a Server. web is the embedded dashboard filesystem rooted at the
// directory containing index.html.
func New(st *store.Store, web fs.FS) *Server {
	return &Server{store: st, web: web}
}

// Handler returns the configured http.Handler (API routes + static fallback).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/profile", s.handleProfile)
	mux.HandleFunc("GET /api/settings", s.handleGetSettings)
	mux.HandleFunc("POST /api/settings", s.handleSaveSettings)
	mux.HandleFunc("POST /api/telegram/test", s.handleTelegramTest)
	mux.HandleFunc("GET /api/latest", s.handleLatest)
	mux.HandleFunc("GET /api/readings", s.handleReadings)
	mux.HandleFunc("DELETE /api/readings/{id}", s.handleDelete)
	// Everything else: static dashboard assets.
	mux.Handle("/", http.FileServer(http.FS(s.web)))
	return logRequests(mux)
}

// ListenAndServe starts the HTTP server on addr (blocking).
func (s *Server) ListenAndServe(addr string) error {
	srv := &http.Server{
		Addr:         addr,
		Handler:      s.Handler(),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 15 * time.Second,
	}
	log.Printf("dashboard + API listening on %s", addr)
	return srv.ListenAndServe()
}

func (s *Server) handleProfile(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.store.GetSettings()
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, cfg.Profile)
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.store.GetSettings()
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, cfg)
}

func (s *Server) handleSaveSettings(w http.ResponseWriter, r *http.Request) {
	var cfg settings.Settings
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&cfg); err != nil {
		jsonError(w, http.StatusBadRequest, "bad json")
		return
	}
	if err := s.store.SaveSettings(cfg); err != nil {
		httpError(w, err)
		return
	}
	// Backfill body-comp on existing readings from the (possibly new) profile so
	// pre-onboarding rows pick up BMI etc.
	if err := s.store.RederiveAll(cfg.Profile); err != nil {
		log.Printf("re-derive readings: %v", err)
	}
	cfg.Normalize() // reflect derived flags back to the caller
	writeJSON(w, map[string]any{"ok": true, "onboarded": cfg.Onboarded})
}

// handleTelegramTest sends a test message. It uses the credentials in the request
// body when provided (so the user can verify before saving), else the saved ones.
func (s *Server) handleTelegramTest(w http.ResponseWriter, r *http.Request) {
	var in struct {
		BotToken string `json:"botToken"`
		ChatID   string `json:"chatId"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&in)
	}
	if in.BotToken == "" || in.ChatID == "" {
		if cfg, err := s.store.GetSettings(); err == nil {
			if in.BotToken == "" {
				in.BotToken = cfg.Telegram.BotToken
			}
			if in.ChatID == "" {
				in.ChatID = cfg.Telegram.ChatID
			}
		}
	}
	if err := telegram.SendTest(in.BotToken, in.ChatID); err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (s *Server) handleLatest(w http.ResponseWriter, r *http.Request) {
	rd, err := s.store.Latest()
	if err != nil {
		httpError(w, err)
		return
	}
	if rd == nil {
		// Empty object so the dashboard can show a friendly "no readings" state.
		writeJSON(w, struct{}{})
		return
	}
	writeJSON(w, rd)
}

func (s *Server) handleReadings(w http.ResponseWriter, r *http.Request) {
	since := r.URL.Query().Get("since")
	list, err := s.store.List(since)
	if err != nil {
		httpError(w, err)
		return
	}
	if list == nil {
		list = []store.Reading{} // serialise as [] not null
	}
	writeJSON(w, list)
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		jsonError(w, http.StatusBadRequest, "bad id")
		return
	}
	ok, err := s.store.Delete(id)
	if err != nil {
		httpError(w, err)
		return
	}
	if !ok {
		jsonError(w, http.StatusNotFound, "not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── helpers ─────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	// Dashboard polls; discourage stale caches for the dynamic API.
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("encode response: %v", err)
	}
}

// jsonError writes a {"error": msg} body with the JSON content type, so every
// error response matches the rest of the API (http.Error would force text/plain).
func jsonError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func httpError(w http.ResponseWriter, err error) {
	log.Printf("api error: %v", err)
	jsonError(w, http.StatusInternalServerError, "internal")
}

// logRequests is a tiny access log so journalctl shows dashboard hits.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.RemoteAddr, r.Method, r.URL.Path)
	})
}
