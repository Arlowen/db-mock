package api

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/auth"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/httpx"
	"github.com/pika/db-mock/internal/instances"
)

func (s *Server) instanceRoutes(r chi.Router) {
	r.Get("/", s.listInstances)
	r.With(requireOperator).Post("/", s.createInstance)
	r.With(requireOperator).Post("/batch-actions/{action}", s.batchInstanceAction)
	r.Get("/{id}", s.getInstance)
	r.Get("/{id}/tasks", s.listInstanceRelatedTasks)
	r.Get("/{id}/cleanup-review", s.getInstanceCleanupReview)
	r.Get("/{id}/backups", s.listInstanceBackups)
	r.With(requireOperator).Post("/{id}/backups/{backupId}/delete", s.deleteInstanceBackup)
	r.With(requireOperator).Post("/{id}/actions/{action}", s.instanceAction)
	r.With(requireOperator).Get("/{id}/connection", s.instanceConnection)
	r.Get("/{id}/logs", s.instanceLogs)
}

func (s *Server) listInstanceRelatedTasks(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	if _, err = s.store.GetInstance(r.Context(), id); err != nil {
		httpx.Error(w, r, err)
		return
	}
	items, err := s.store.ListInstanceRelatedTasks(r.Context(), id, 100)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) listInstanceBackups(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	if _, err = s.store.GetInstance(r.Context(), id); err != nil {
		httpx.Error(w, r, err)
		return
	}
	items, err := s.store.ListInstanceBackups(r.Context(), id)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) deleteInstanceBackup(w http.ResponseWriter, r *http.Request) {
	instanceID, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	backupID, err := httpx.UUIDParam(chi.URLParam(r, "backupId"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	var input struct {
		ConfirmName string `json:"confirmName"`
	}
	if err = httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	backup, err := s.store.GetInstanceBackup(r.Context(), backupID)
	if err != nil || backup.InstanceID != instanceID {
		if err == nil {
			err = domain.ErrNotFound
		}
		httpx.Error(w, r, err)
		return
	}
	if strings.TrimSpace(input.ConfirmName) != backup.Name {
		httpx.Error(w, r, domain.ErrInvalid)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	backup, task, err := s.instances.DeleteBackup(r.Context(), actor.User.ID, instanceID, backupID)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	_ = s.auditWithChanges(r, actor, "instance.backup.delete", "backup", &backup.ID, backup.Name, &task.ID,
		"success", "", map[string]any{"instanceId": instanceID, "sizeBytes": backup.SizeBytes})
	httpx.JSON(w, http.StatusAccepted, map[string]any{"backup": backup, "task": task})
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

func (s *Server) getInstanceCleanupReview(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	review, err := s.instances.GetCleanupReview(r.Context(), id)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, review)
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
	_ = s.auditWithChanges(r, actor, "instance.create", "instance", &item.ID, item.Name, &task.ID, "success", "", instanceAuditChanges(domain.Instance{}, item))
	httpx.JSON(w, http.StatusAccepted, map[string]any{"instance": item, "task": task})
}

func (s *Server) instanceAction(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	action := chi.URLParam(r, "action")
	if action != "start" && action != "stop" && action != "restart" && action != "delete" {
		httpx.Error(w, r, domain.ErrInvalid)
		return
	}
	var input struct {
		ConfirmName string `json:"confirmName"`
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
	task, err := s.instances.Action(r.Context(), actor.User.ID, id, action)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	_ = s.audit(r, actor, "instance."+action, "instance", &id, instance.Name, &task.ID, "success", "")
	httpx.JSON(w, http.StatusAccepted, task)
}

func (s *Server) batchInstanceAction(w http.ResponseWriter, r *http.Request) {
	action := chi.URLParam(r, "action")
	var input struct {
		InstanceIDs []uuid.UUID `json:"instanceIds"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	outcomes, err := s.instances.BatchAction(r.Context(), actor.User.ID, action, input.InstanceIDs)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	type acceptedItem struct {
		InstanceID   uuid.UUID   `json:"instanceId"`
		InstanceName string      `json:"instanceName"`
		Task         domain.Task `json:"task"`
	}
	type rejectedItem struct {
		InstanceID   uuid.UUID `json:"instanceId"`
		InstanceName string    `json:"instanceName,omitempty"`
		Code         string    `json:"code"`
		Message      string    `json:"message"`
	}
	accepted := make([]acceptedItem, 0, len(outcomes))
	rejected := make([]rejectedItem, 0)
	for _, outcome := range outcomes {
		if outcome.Err != nil {
			code, message := batchActionError(outcome.Err)
			rejected = append(rejected, rejectedItem{InstanceID: outcome.InstanceID,
				InstanceName: outcome.InstanceName, Code: code, Message: message})
			continue
		}
		if outcome.Task == nil {
			rejected = append(rejected, rejectedItem{InstanceID: outcome.InstanceID,
				InstanceName: outcome.InstanceName, Code: "internal_error", Message: "Internal server error"})
			continue
		}
		accepted = append(accepted, acceptedItem{InstanceID: outcome.InstanceID,
			InstanceName: outcome.InstanceName, Task: *outcome.Task})
		_ = s.audit(r, actor, "instance."+action, "instance", &outcome.InstanceID,
			outcome.InstanceName, &outcome.Task.ID, "success", "")
	}
	status := http.StatusOK
	if len(accepted) > 0 {
		status = http.StatusAccepted
	}
	httpx.JSON(w, status, map[string]any{
		"action": action, "accepted": accepted, "rejected": rejected,
	})
}

func batchActionError(err error) (string, string) {
	switch {
	case errors.Is(err, domain.ErrNotFound):
		return "not_found", "Resource not found"
	case errors.Is(err, domain.ErrConflict):
		return "resource_conflict", err.Error()
	case errors.Is(err, domain.ErrInvalid):
		return "invalid_input", err.Error()
	case errors.Is(err, domain.ErrForbidden):
		return "forbidden", "Operation forbidden"
	case errors.Is(err, domain.ErrUnauthorized):
		return "unauthorized", "Authentication required"
	case errors.Is(err, domain.ErrUnavailable):
		return "resource_unavailable", err.Error()
	default:
		return "internal_error", "Internal server error"
	}
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
		httpx.Error(w, r, fmt.Errorf("%w: unable to reach the instance host over SSH", domain.ErrUnavailable))
		return
	}
	if r.URL.Query().Get("download") == "true" {
		w.Header().Set("Content-Disposition", `attachment; filename="`+strings.ReplaceAll(instance.Name, `"`, "")+`.log"`)
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte(logs))
}
