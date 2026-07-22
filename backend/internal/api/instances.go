package api

import (
	"encoding/json"
	"errors"
	"fmt"
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
	r.Get("/{id}/backups", s.listInstanceBackups)
	r.Post("/{id}/backups", s.createInstanceBackup)
	r.Get("/{id}/backup-policy", s.getInstanceBackupPolicy)
	r.Put("/{id}/backup-policy", s.updateInstanceBackupPolicy)
	r.Post("/{id}/backups/{backupId}/restore", s.restoreInstanceBackup)
	r.Post("/{id}/backups/{backupId}/delete", s.deleteInstanceBackup)
	r.Post("/{id}/actions/{action}", s.instanceAction)
	r.Get("/{id}/connection", s.instanceConnection)
	r.Get("/{id}/logs", s.instanceLogs)
	r.Get("/{id}/metrics", s.instanceMetrics)
}

func (s *Server) getInstanceBackupPolicy(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	policy, err := s.instances.GetBackupPolicy(r.Context(), id)
	if errors.Is(err, domain.ErrNotFound) {
		if _, instanceErr := s.store.GetInstance(r.Context(), id); instanceErr != nil {
			httpx.Error(w, r, instanceErr)
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"policy": nil})
		return
	}
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"policy": policy})
}

func (s *Server) updateInstanceBackupPolicy(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	var input instances.BackupPolicyInput
	if err = httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	before, beforeErr := s.store.GetInstanceBackupPolicy(r.Context(), id)
	if beforeErr != nil && !errors.Is(beforeErr, domain.ErrNotFound) {
		httpx.Error(w, r, beforeErr)
		return
	}
	instance, err := s.store.GetInstance(r.Context(), id)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	policy, err := s.instances.UpdateBackupPolicy(r.Context(), actor.User.ID, id, input, time.Now())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	changes := map[string]any{
		"enabled": map[string]any{"from": before.Enabled, "to": policy.Enabled},
		"schedule": map[string]any{
			"from": map[string]any{"frequency": before.Frequency, "weekday": before.Weekday, "hour": before.Hour,
				"minute": before.Minute, "timezone": before.Timezone},
			"to": map[string]any{"frequency": policy.Frequency, "weekday": policy.Weekday, "hour": policy.Hour,
				"minute": policy.Minute, "timezone": policy.Timezone},
		},
		"retentionCount": map[string]any{"from": before.RetentionCount, "to": policy.RetentionCount},
	}
	_ = s.auditWithChanges(r, actor, "instance.backup_policy.update", "instance", &id, instance.Name, nil,
		"success", "", changes)
	httpx.JSON(w, http.StatusOK, map[string]any{"policy": policy})
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

func (s *Server) createInstanceBackup(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	if err = httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	backup, task, err := s.instances.CreateBackup(r.Context(), actor.User.ID, id, input.Name)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	_ = s.auditWithChanges(r, actor, "instance.backup.create", "backup", &backup.ID, backup.Name, &task.ID,
		"success", "", map[string]any{"instanceId": id, "templateVersionId": backup.TemplateVersionID})
	httpx.JSON(w, http.StatusAccepted, map[string]any{"backup": backup, "task": task})
}

func (s *Server) restoreInstanceBackup(w http.ResponseWriter, r *http.Request) {
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
	instance, err := s.store.GetInstance(r.Context(), instanceID)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	if strings.TrimSpace(input.ConfirmName) != instance.Name {
		httpx.Error(w, r, domain.ErrInvalid)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	backup, task, err := s.instances.RestoreBackup(r.Context(), actor.User.ID, instanceID, backupID)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	_ = s.auditWithChanges(r, actor, "instance.backup.restore", "backup", &backup.ID, backup.Name, &task.ID,
		"success", "", map[string]any{"instanceId": instanceID, "templateVersionId": backup.TemplateVersionID})
	httpx.JSON(w, http.StatusAccepted, map[string]any{"backup": backup, "task": task})
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
	before, err := s.store.GetInstance(r.Context(), id)
	if err != nil {
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
	_ = s.auditWithChanges(r, actor, "instance.update", "instance", &id, item.Name, nil, "success", "", instanceAuditChanges(before, item))
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
		ConfirmName       string            `json:"confirmName"`
		TemplateVersionID *uuid.UUID        `json:"templateVersionId"`
		ImageSource       string            `json:"imageSource"`
		ImageArtifactID   *uuid.UUID        `json:"imageArtifactId"`
		RegistryID        *uuid.UUID        `json:"registryId"`
		CPU               float64           `json:"cpu"`
		MemoryBytes       int64             `json:"memoryBytes"`
		DiskBytes         int64             `json:"diskBytes"`
		ExtraEnvironment  map[string]string `json:"extraEnvironment"`
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
	task, err := s.instances.Action(r.Context(), actor.User.ID, id, action, instances.ActionRequest{
		NewTemplateVersionID: input.TemplateVersionID, ImageSource: input.ImageSource,
		ImageArtifactID: input.ImageArtifactID, RegistryID: input.RegistryID,
		CPU: input.CPU, MemoryBytes: input.MemoryBytes, DiskBytes: input.DiskBytes,
		ExtraEnvironment: input.ExtraEnvironment,
	})
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	if action == "reconfigure" {
		_ = s.auditWithChanges(r, actor, "instance."+action, "instance", &id, instance.Name, &task.ID, "success", "",
			instanceReconfigureAuditChanges(instance, input.CPU, input.MemoryBytes, input.DiskBytes, input.ExtraEnvironment))
	} else if action == "upgrade" {
		changes := map[string]any{"imageSource": input.ImageSource}
		if input.TemplateVersionID != nil {
			changes["templateVersionId"] = input.TemplateVersionID.String()
		}
		if input.ImageArtifactID != nil {
			changes["imageArtifactId"] = input.ImageArtifactID.String()
		}
		if input.RegistryID != nil {
			changes["registryId"] = input.RegistryID.String()
		}
		_ = s.auditWithChanges(r, actor, "instance."+action, "instance", &id, instance.Name, &task.ID, "success", "", changes)
	} else {
		_ = s.audit(r, actor, "instance."+action, "instance", &id, instance.Name, &task.ID, "success", "")
	}
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
		httpx.Error(w, r, fmt.Errorf("%w: unable to reach the instance host over SSH", domain.ErrUnavailable))
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
