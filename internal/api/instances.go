package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/auth"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/httpx"
	"github.com/pika/db-mock/internal/instances"
)

func (s *Server) instanceRoutes(r chi.Router) {
	r.Get("/", s.listInstances)
	r.Post("/", s.createInstance)
	r.Get("/{id}", s.getInstance)
	r.Patch("/{id}", s.updateInstance)
	r.Post("/{id}/actions/{action}", s.instanceAction)
	r.Get("/{id}/connection", s.instanceConnection)
	r.Get("/{id}/logs", s.instanceLogs)
	r.Get("/{id}/metrics", s.instanceMetrics)
}

func optionalUUID(value string) (*uuid.UUID, error) {
	if value == "" {
		return nil, nil
	}
	id, err := uuid.Parse(value)
	if err != nil {
		return nil, domain.ErrInvalid
	}
	return &id, nil
}
func (s *Server) listInstances(w http.ResponseWriter, r *http.Request) {
	hostID, err := optionalUUID(r.URL.Query().Get("hostId"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	projectID, err := optionalUUID(r.URL.Query().Get("projectId"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	items, err := s.store.ListInstances(r.Context(), hostID, projectID, r.URL.Query().Get("status"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}
func (s *Server) getInstance(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	item, err := s.store.GetInstance(r.Context(), id)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, item)
}

func (s *Server) createInstance(w http.ResponseWriter, r *http.Request) {
	var input instances.CreateRequest
	if err := httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	item, task, err := s.instances.Create(r.Context(), actor.User.ID, input)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	_ = s.audit(r, actor, "instance.create", "instance", &item.ID, item.Name, &task.ID, "success", "")
	httpx.JSON(w, http.StatusAccepted, map[string]any{"instance": item, "task": task})
}

func (s *Server) updateInstance(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	var input struct {
		Name        string            `json:"name"`
		ProjectID   *uuid.UUID        `json:"projectId"`
		Environment string            `json:"environment"`
		Labels      map[string]string `json:"labels"`
		AutoRestart bool              `json:"autoRestart"`
	}
	if err = httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	labels, _ := json.Marshal(input.Labels)
	item, err := s.store.UpdateInstanceMetadata(r.Context(), id, input.Name, input.ProjectID, input.Environment, labels, input.AutoRestart)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "instance.update", "instance", &id, item.Name, nil, "success", "")
	httpx.JSON(w, http.StatusOK, item)
}

func (s *Server) instanceAction(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	action := chi.URLParam(r, "action")
	var input struct {
		ConfirmName       string     `json:"confirmName"`
		TemplateVersionID *uuid.UUID `json:"templateVersionId"`
	}
	if r.ContentLength != 0 {
		if err = httpx.Decode(r, &input); err != nil {
			httpx.Error(w, r, err)
			return
		}
	}
	instance, err := s.store.GetInstance(r.Context(), id)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	if action == "delete" && strings.TrimSpace(input.ConfirmName) != instance.Name {
		httpx.Error(w, r, domain.ErrInvalid)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	task, err := s.instances.Action(r.Context(), actor.User.ID, id, action, input.TemplateVersionID)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	_ = s.audit(r, actor, "instance."+action, "instance", &id, instance.Name, &task.ID, "success", "")
	httpx.JSON(w, http.StatusAccepted, task)
}

func (s *Server) instanceConnection(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	item, err := s.instances.Connection(r.Context(), id)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "instance.connection.view", "instance", &id, "", nil, "success", "")
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, item)
}

func (s *Server) instanceLogs(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	instance, err := s.store.GetInstance(r.Context(), id)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	host, err := s.store.GetHost(r.Context(), instance.HostID)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	tail, _ := strconv.Atoi(r.URL.Query().Get("tail"))
	logs, err := s.docker.Logs(r.Context(), host, instance, tail)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	if r.URL.Query().Get("download") == "true" {
		w.Header().Set("Content-Disposition", `attachment; filename="`+strings.ReplaceAll(instance.Name, `"`, "")+`.log"`)
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte(logs))
}

func (s *Server) instanceMetrics(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	hours, _ := strconv.Atoi(r.URL.Query().Get("hours"))
	if hours <= 0 || hours > 168 {
		hours = 24
	}
	items, err := s.store.ListInstanceMetrics(r.Context(), id, time.Now().Add(-time.Duration(hours)*time.Hour), 2000)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}
