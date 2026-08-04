package api

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/auth"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/httpx"
)

func (s *Server) taskRoutes(r chi.Router) {
	r.Get("/", s.listTasks)
	r.Get("/{id}", s.getTask)
	r.Get("/{id}/logs", s.taskLogs)
	r.With(requireOperator).Post("/{id}/cancel", s.cancelTask)
	r.With(requireOperator).Post("/{id}/retry", s.retryTask)
}
func (s *Server) listTasks(w http.ResponseWriter, r *http.Request) {
	if rawIDs := r.URL.Query().Get("ids"); rawIDs != "" {
		ids, err := parseTaskIDs(rawIDs)
		if err != nil {
			httpx.Error(w, r, err)
			return
		}
		items, err := s.store.ListTasksByIDs(r.Context(), ids)
		if err != nil {
			httpx.Error(w, r, err)
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
		return
	}
	var resourceID *uuid.UUID
	if value := r.URL.Query().Get("resourceId"); value != "" {
		parsed, err := httpx.UUIDParam(value)
		if err != nil {
			httpx.Error(w, r, err)
			return
		}
		resourceID = &parsed
	}
	items, err := s.store.ListTasks(r.Context(), r.URL.Query().Get("status"), r.URL.Query().Get("resourceType"), resourceID, 100)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func parseTaskIDs(raw string) ([]uuid.UUID, error) {
	values := strings.Split(raw, ",")
	if len(values) == 0 || len(values) > 100 {
		return nil, fmt.Errorf("%w: select between 1 and 100 task IDs", domain.ErrInvalid)
	}
	ids := make([]uuid.UUID, 0, len(values))
	seen := make(map[uuid.UUID]struct{}, len(values))
	for _, value := range values {
		id, err := uuid.Parse(strings.TrimSpace(value))
		if err != nil || id == uuid.Nil {
			return nil, fmt.Errorf("%w: task IDs must be valid UUIDs", domain.ErrInvalid)
		}
		if _, duplicate := seen[id]; duplicate {
			return nil, fmt.Errorf("%w: task IDs must be unique", domain.ErrInvalid)
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids, nil
}
func (s *Server) getTask(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	item, err := s.store.GetTask(r.Context(), id)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, item)
}
func (s *Server) taskLogs(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	items, err := s.store.ListTaskLogs(r.Context(), id, after, 1000)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}
func (s *Server) cancelTask(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	task, err := s.tasks.CancelTask(r.Context(), id)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "task.cancel", "task", &id, "", nil, "success", "")
	status := http.StatusAccepted
	if task.Status == "canceled" {
		status = http.StatusOK
	}
	httpx.JSON(w, status, task)
}
func (s *Server) retryTask(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	task, err := s.tasks.RetryTask(r.Context(), id, actor.User.ID)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	s.tasks.Wake()
	_ = s.audit(r, actor, "task.retry", "task", &id, "", &task.ID, "success", "")
	httpx.JSON(w, http.StatusAccepted, task)
}
