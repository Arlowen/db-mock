package api

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/auth"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/httpx"
	platformsettings "github.com/pika/db-mock/internal/settings"
	"github.com/pika/db-mock/internal/store"
)

func (s *Server) alertRoutes(r chi.Router) {
	r.Get("/", s.listAlerts)
	r.Post("/{id}/{status}", s.updateAlert)
}
func (s *Server) listAlerts(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListAlerts(r.Context(), r.URL.Query().Get("status"), 200)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}
func (s *Server) updateAlert(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	status := chi.URLParam(r, "status")
	if status != "acknowledged" && status != "resolved" {
		httpx.Error(w, r, domain.ErrInvalid)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	if err = s.store.SetAlertStatus(r.Context(), id, status, actor.User.Username); err != nil {
		httpx.Error(w, r, err)
		return
	}
	_ = s.audit(r, actor, "alert."+status, "alert", &id, "", nil, "success", "")
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) webhookRoutes(r chi.Router) {
	r.Get("/", s.listWebhooks)
	r.Post("/", s.createWebhook)
	r.Put("/{id}", s.updateWebhook)
	r.Delete("/{id}", s.deleteWebhook)
	r.Post("/{id}/test", s.testWebhook)
	r.Get("/{id}/deliveries", s.listWebhookDeliveries)
	r.Post("/{id}/deliveries/{deliveryID}/retry", s.retryWebhookDelivery)
}

type webhookRequest struct {
	Name        string   `json:"name"`
	URL         string   `json:"url"`
	Secret      string   `json:"secret"`
	ClearSecret bool     `json:"clearSecret"`
	Events      []string `json:"events"`
	Enabled     bool     `json:"enabled"`
}

var supportedWebhookEvents = map[string]bool{
	"*": true, "alert.created": true, "instance.failed": true, "instance.restart_failed": true,
	"host.offline": true, "host.disk_warning": true, "host.disk_critical": true,
	"task.finished": true, "task.succeeded": true, "task.failed": true, "webhook.test": true,
}

func normalizeWebhook(input *webhookRequest) error {
	input.Name = strings.TrimSpace(input.Name)
	input.URL = strings.TrimSpace(input.URL)
	parsed, err := url.Parse(input.URL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.Fragment != "" {
		return domain.ErrInvalid
	}
	if input.Name == "" || len(input.Name) > 120 || len(input.URL) > 2048 || len(input.Secret) > 4096 || len(input.Events) == 0 {
		return domain.ErrInvalid
	}
	seen := make(map[string]bool, len(input.Events))
	events := make([]string, 0, len(input.Events))
	hasWildcard := false
	for _, event := range input.Events {
		event = strings.TrimSpace(event)
		if !supportedWebhookEvents[event] {
			return domain.ErrInvalid
		}
		if event == "*" {
			hasWildcard = true
			continue
		}
		if !seen[event] {
			seen[event] = true
			events = append(events, event)
		}
	}
	if hasWildcard {
		input.Events = []string{"*"}
	} else {
		input.Events = events
	}
	return nil
}
func (s *Server) listWebhooks(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListWebhooks(r.Context())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}
func (s *Server) createWebhook(w http.ResponseWriter, r *http.Request) {
	var input webhookRequest
	if err := httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	if err := normalizeWebhook(&input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	id := uuid.New()
	secret, err := s.sealOptional(input.Secret, "webhook:"+id.String())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	events, _ := json.Marshal(input.Events)
	item, err := s.store.CreateWebhook(r.Context(), store.WebhookInput{ID: id, Name: input.Name, URL: input.URL, EncryptedSecret: secret, Events: events, Enabled: input.Enabled})
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "webhook.create", "webhook", &id, item.Name, nil, "success", "")
	httpx.JSON(w, http.StatusCreated, item)
}
func (s *Server) updateWebhook(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	var input webhookRequest
	if err = httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	if err = normalizeWebhook(&input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	secret, err := s.sealOptional(input.Secret, "webhook:"+id.String())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	events, _ := json.Marshal(input.Events)
	item, err := s.store.UpdateWebhook(r.Context(), id, store.WebhookInput{Name: input.Name, URL: input.URL, EncryptedSecret: secret, ClearSecret: input.ClearSecret, Events: events, Enabled: input.Enabled})
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "webhook.update", "webhook", &id, item.Name, nil, "success", "")
	httpx.JSON(w, http.StatusOK, item)
}
func (s *Server) deleteWebhook(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	if err = s.store.DeleteWebhook(r.Context(), id); err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "webhook.delete", "webhook", &id, "", nil, "success", "")
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}
func (s *Server) testWebhook(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	item, getErr := s.store.GetWebhook(r.Context(), id)
	if getErr != nil {
		err = getErr
		httpx.Error(w, r, err)
		return
	}
	if !item.Enabled {
		httpx.Error(w, r, fmt.Errorf("%w: webhook is disabled", domain.ErrConflict))
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	payload := map[string]any{"event": "webhook.test", "sentAt": time.Now(), "user": actor.User.Username}
	deliveryID, err := s.store.EnqueueWebhookFor(r.Context(), id, "webhook.test", payload)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	_ = s.audit(r, actor, "webhook.test", "webhook", &id, "", nil, "success", "")
	httpx.JSON(w, http.StatusAccepted, map[string]any{"queued": true, "deliveryId": deliveryID})
}

func (s *Server) listWebhookDeliveries(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	if _, err = s.store.GetWebhook(r.Context(), id); err != nil {
		httpx.Error(w, r, err)
		return
	}
	items, err := s.store.ListWebhookDeliveries(r.Context(), id, 50)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) retryWebhookDelivery(w http.ResponseWriter, r *http.Request) {
	webhookID, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	deliveryID, err := httpx.UUIDParam(chi.URLParam(r, "deliveryID"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	hook, getErr := s.store.GetWebhook(r.Context(), webhookID)
	if getErr != nil {
		httpx.Error(w, r, getErr)
		return
	}
	if !hook.Enabled {
		httpx.Error(w, r, fmt.Errorf("%w: webhook is disabled", domain.ErrConflict))
		return
	}
	if err = s.store.RetryWebhookDelivery(r.Context(), webhookID, deliveryID); err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "webhook.delivery_retry", "webhook", &webhookID, "", nil, "success", "")
	httpx.JSON(w, http.StatusAccepted, map[string]bool{"queued": true})
}

func (s *Server) auditRoutes(r chi.Router) {
	r.Get("/", s.listAudit)
	r.Get("/export", s.exportAudit)
	r.Post("/clear", s.clearAudit)
}
func auditBefore(r *http.Request) time.Time {
	value := r.URL.Query().Get("before")
	parsed, _ := time.Parse(time.RFC3339, value)
	return parsed
}
func (s *Server) listAudit(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListAudit(r.Context(), r.URL.Query().Get("search"), r.URL.Query().Get("resourceType"), auditBefore(r), 200)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}
func (s *Server) exportAudit(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListAudit(r.Context(), r.URL.Query().Get("search"), r.URL.Query().Get("resourceType"), auditBefore(r), 500)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="dbmock-audit.csv"`)
	_, _ = w.Write([]byte{0xEF, 0xBB, 0xBF})
	writer := csv.NewWriter(w)
	_ = writer.Write([]string{"ID", "Time", "User", "Action", "Resource type", "Resource ID", "Resource name", "Result", "IP", "Request ID", "Task ID", "Changes", "Message"})
	for _, item := range items {
		row := []string{strconv.FormatInt(item.ID, 10), item.CreatedAt.Format(time.RFC3339), item.Username, item.Action,
			item.ResourceType, uuidString(item.ResourceID), item.ResourceName, item.Result, item.IP, item.RequestID,
			uuidString(item.TaskID), string(item.Changes), item.Message}
		for index := range row {
			row[index] = safeCSVCell(row[index])
		}
		_ = writer.Write(row)
	}
	writer.Flush()
}

func uuidString(value *uuid.UUID) string {
	if value == nil {
		return ""
	}
	return value.String()
}

func safeCSVCell(value string) string {
	trimmed := strings.TrimLeft(value, " \t\r\n")
	if trimmed == "" {
		return value
	}
	switch trimmed[0] {
	case '=', '+', '-', '@':
		return "'" + value
	default:
		return value
	}
}
func (s *Server) clearAudit(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Before  time.Time `json:"before"`
		Confirm string    `json:"confirm"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	if input.Confirm != "CLEAR" || input.Before.IsZero() {
		httpx.Error(w, r, domain.ErrInvalid)
		return
	}
	count, err := s.store.ClearAudit(r.Context(), input.Before)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "audit.clear", "audit", nil, "", nil, "success", "Deleted "+strconv.FormatInt(count, 10)+" audit records")
	httpx.JSON(w, http.StatusOK, map[string]int64{"deleted": count})
}

func (s *Server) settingRoutes(r chi.Router) {
	r.Get("/", s.getSettings)
	r.Put("/{key}", s.putSetting)
}
func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.GetSettings(r.Context())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	items["uploads"] = uploadSettingView(items["uploads"], s.config.MaxUploadBytes)
	items["timezone"] = timezoneSettingView(items["timezone"], s.config.Timezone)
	httpx.JSON(w, http.StatusOK, items)
}
func (s *Server) putSetting(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	if key == "" {
		httpx.Error(w, r, domain.ErrInvalid)
		return
	}
	body := http.MaxBytesReader(w, r.Body, 1024*1024)
	data, err := io.ReadAll(body)
	if err != nil || !json.Valid(data) {
		httpx.Error(w, r, domain.ErrInvalid)
		return
	}
	data, err = normalizeSettingValue(key, data, s.config.MaxUploadBytes, s.config.Timezone)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	if err = s.store.PutSetting(r.Context(), key, data); err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "setting.update", "setting", nil, key, nil, "success", "")
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func normalizeSettingValue(key string, value json.RawMessage, maxUploadBytes int64, defaultTimezone string) (json.RawMessage, error) {
	switch key {
	case "monitoring":
		return platformsettings.NormalizeMonitoringPolicy(value)
	case "uploads":
		return platformsettings.NormalizeUploadPolicy(value, maxUploadBytes)
	case "timezone":
		return platformsettings.NormalizeTimezone(value)
	}
	return value, nil
}

func timezoneSettingView(value json.RawMessage, fallback string) json.RawMessage {
	result, _ := json.Marshal(platformsettings.EffectiveTimezone(value, fallback))
	return result
}

func uploadSettingView(value json.RawMessage, maxAllowedBytes int64) json.RawMessage {
	defaults := platformsettings.DefaultUploadPolicy(maxAllowedBytes)
	policy, err := platformsettings.DecodeUploadPolicy(value, defaults, maxAllowedBytes)
	if err != nil {
		policy = defaults
	}
	view := struct {
		platformsettings.UploadPolicy
		MaxAllowedBytes int64 `json:"maxAllowedBytes"`
	}{UploadPolicy: policy, MaxAllowedBytes: maxAllowedBytes}
	result, _ := json.Marshal(view)
	return result
}
