package api

import (
	"fmt"
	"net/http"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/auth"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/httpx"
	"github.com/pika/db-mock/internal/store"
)

type credentialRequest struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Password    string `json:"password"`
	Locale      string `json:"locale"`
}

func (s *Server) setupStatus(w http.ResponseWriter, r *http.Request) {
	initialized, err := s.store.IsInitialized(r.Context())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"initialized": initialized})
}

func (s *Server) setup(w http.ResponseWriter, r *http.Request) {
	var input credentialRequest
	if err := httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	user, token, err := s.auth.Setup(r.Context(), input.Username, input.DisplayName, input.Password, input.Locale, auth.ClientIP(r), r.UserAgent())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	s.auth.SetCookie(w, token)
	_ = s.store.AddAudit(r.Context(), store.AuditInput{UserID: &user.ID, Username: user.Username, Action: "platform.setup", ResourceType: "platform", IP: auth.ClientIP(r), RequestID: auth.RequestID(r.Context()), Result: "success"})
	httpx.JSON(w, http.StatusCreated, map[string]any{"user": user})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	initialized, err := s.store.IsInitialized(r.Context())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	if !initialized {
		httpx.Error(w, r, domain.ErrNotConfigured)
		return
	}
	var input credentialRequest
	if err := httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	user, token, err := s.auth.Login(r.Context(), input.Username, input.Password, auth.ClientIP(r), r.UserAgent())
	if err != nil {
		_ = s.store.AddAudit(r.Context(), store.AuditInput{Username: input.Username, Action: "auth.login", ResourceType: "session", IP: auth.ClientIP(r), RequestID: auth.RequestID(r.Context()), Result: "failure", Message: "Invalid credentials"})
		httpx.Error(w, r, err)
		return
	}
	s.auth.SetCookie(w, token)
	_ = s.store.AddAudit(r.Context(), store.AuditInput{UserID: &user.ID, Username: user.Username, Action: "auth.login", ResourceType: "session", IP: auth.ClientIP(r), RequestID: auth.RequestID(r.Context()), Result: "success"})
	httpx.JSON(w, http.StatusOK, map[string]any{"user": user})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	cookie, _ := r.Cookie(auth.CookieName)
	if cookie != nil {
		_ = s.auth.Logout(r.Context(), cookie.Value)
	}
	s.auth.ClearCookie(w)
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "auth.logout", "session", nil, "", nil, "success", "")
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	actor, _ := auth.ActorFrom(r.Context())
	httpx.JSON(w, http.StatusOK, map[string]any{"user": actor.User})
}

func (s *Server) updateMe(w http.ResponseWriter, r *http.Request) {
	actor, _ := auth.ActorFrom(r.Context())
	var input struct {
		Locale string `json:"locale"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	if !supportedLocale(input.Locale) {
		httpx.Error(w, r, fmt.Errorf("%w: unsupported language preference", domain.ErrInvalid))
		return
	}
	user, err := s.store.UpdateUser(r.Context(), actor.User.ID, "", input.Locale, nil, "")
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	_ = s.audit(r, actor, "user.locale_update", "user", &user.ID, user.Username, nil, "success", "")
	httpx.JSON(w, http.StatusOK, map[string]any{"user": user})
}

func supportedLocale(value string) bool {
	return value == "zh-CN" || value == "en-US"
}
func (s *Server) dashboard(w http.ResponseWriter, r *http.Request) {
	value, err := s.store.Dashboard(r.Context())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, value)
}

func (s *Server) audit(r *http.Request, actor auth.Actor, action, resourceType string, resourceID *uuid.UUID, resourceName string, taskID *uuid.UUID, result, message string) error {
	return s.store.AddAudit(r.Context(), store.AuditInput{UserID: &actor.User.ID, Username: actor.User.Username, Action: action, ResourceType: resourceType, ResourceID: resourceID, ResourceName: resourceName, IP: auth.ClientIP(r), RequestID: auth.RequestID(r.Context()), TaskID: taskID, Result: result, Message: message})
}
