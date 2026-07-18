package api

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/auth"
	appcrypto "github.com/pika/db-mock/internal/crypto"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/httpx"
)

func (s *Server) userRoutes(r chi.Router) {
	r.Get("/", s.listUsers)
	r.Post("/", s.createUser)
	r.Patch("/{id}", s.updateUser)
}
func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListUsers(r.Context())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	var input credentialRequest
	if err := httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	hash, err := appcrypto.HashPassword(input.Password)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	user, err := s.store.CreateUser(r.Context(), input.Username, input.DisplayName, input.Locale, hash)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "user.create", "user", &user.ID, user.Username, nil, "success", "")
	httpx.JSON(w, http.StatusCreated, user)
}

func (s *Server) updateUser(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	var input struct {
		DisplayName string `json:"displayName"`
		Locale      string `json:"locale"`
		Disabled    *bool  `json:"disabled"`
		Password    string `json:"password"`
	}
	if err = httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	if err = validateUserUpdate(actor.User.ID, id, input.Disabled); err != nil {
		httpx.Error(w, r, err)
		return
	}
	hash := ""
	if input.Password != "" {
		hash, err = appcrypto.HashPassword(input.Password)
		if err != nil {
			httpx.Error(w, r, err)
			return
		}
	}
	user, err := s.store.UpdateUser(r.Context(), id, input.DisplayName, input.Locale, input.Disabled, hash)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	if input.Disabled != nil && *input.Disabled {
		_ = s.store.DeleteUserSessions(r.Context(), id)
	}
	_ = s.audit(r, actor, "user.update", "user", &id, user.Username, nil, "success", "")
	httpx.JSON(w, http.StatusOK, user)
}

func validateUserUpdate(actorID, targetID uuid.UUID, disabled *bool) error {
	if actorID == targetID && disabled != nil && *disabled {
		return fmt.Errorf("%w: current user cannot be disabled", domain.ErrConflict)
	}
	return nil
}

func (s *Server) projectRoutes(r chi.Router) {
	r.Get("/", s.listProjects)
	r.Post("/", s.createProject)
	r.Put("/{id}", s.updateProject)
	r.Delete("/{id}", s.deleteProject)
}

type projectRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Color       string `json:"color"`
}

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListProjects(r.Context())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}
func (s *Server) createProject(w http.ResponseWriter, r *http.Request) {
	var input projectRequest
	if err := httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	item, err := s.store.CreateProject(r.Context(), input.Name, input.Description, input.Color)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "project.create", "project", &item.ID, item.Name, nil, "success", "")
	httpx.JSON(w, http.StatusCreated, item)
}
func (s *Server) updateProject(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	var input projectRequest
	if err = httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	item, err := s.store.UpdateProject(r.Context(), id, input.Name, input.Description, input.Color)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "project.update", "project", &id, item.Name, nil, "success", "")
	httpx.JSON(w, http.StatusOK, item)
}
func (s *Server) deleteProject(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	if err = s.store.DeleteProject(r.Context(), id); err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "project.delete", "project", &id, "", nil, "success", "")
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}
