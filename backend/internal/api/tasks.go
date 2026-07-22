package api

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/auth"
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
	if err = s.store.RequestTaskCancel(r.Context(), id); err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "task.cancel", "task", &id, "", nil, "success", "")
	httpx.JSON(w, http.StatusAccepted, map[string]bool{"ok": true})
}
func (s *Server) retryTask(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	task, err := s.store.RetryTask(r.Context(), id, actor.User.ID)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	s.tasks.Wake()
	_ = s.audit(r, actor, "task.retry", "task", &id, "", &task.ID, "success", "")
	httpx.JSON(w, http.StatusAccepted, task)
}
