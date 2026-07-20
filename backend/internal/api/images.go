package api

import (
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/auth"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/httpx"
)

func (s *Server) imageRoutes(r chi.Router) {
	r.Get("/", s.listImages)
	r.Get("/unused", s.listUnusedImages)
	r.Post("/cleanup", s.cleanupUnusedImages)
	r.Delete("/{id}", s.deleteImage)
	r.Post("/uploads", s.beginImageUpload)
	r.Get("/uploads/{id}", s.getImageUpload)
	r.Put("/uploads/{id}/chunk", s.uploadImageChunk)
	r.Post("/uploads/{id}/complete", s.completeImageUpload)
	r.Delete("/uploads/{id}", s.cancelImageUpload)
}
func (s *Server) cancelImageUpload(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	if err = s.images.Cancel(r.Context(), actor.User.ID, id); err != nil {
		httpx.Error(w, r, err)
		return
	}
	_ = s.audit(r, actor, "image.upload.cancel", "image_upload", &id, "", nil, "success", "")
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}
func (s *Server) listImages(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListImageArtifacts(r.Context())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}

func imageCleanupCutoff(days int, now time.Time) (int, time.Time, error) {
	if days == 0 {
		days = 30
	}
	if days < 1 || days > 3650 {
		return 0, time.Time{}, domain.ErrInvalid
	}
	return days, now.Add(-time.Duration(days) * 24 * time.Hour), nil
}

func (s *Server) listUnusedImages(w http.ResponseWriter, r *http.Request) {
	days := 0
	var err error
	if value := r.URL.Query().Get("olderThanDays"); value != "" {
		days, err = strconv.Atoi(value)
		if err != nil {
			httpx.Error(w, r, domain.ErrInvalid)
			return
		}
	}
	days, cutoff, err := imageCleanupCutoff(days, time.Now().UTC())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	items, err := s.store.ListUnusedImageArtifacts(r.Context(), cutoff)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	var totalBytes int64
	for _, item := range items {
		totalBytes += item.SizeBytes
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "totalBytes": totalBytes, "olderThanDays": days, "cutoff": cutoff})
}

func uniqueImageIDs(values []uuid.UUID) []uuid.UUID {
	seen := make(map[uuid.UUID]struct{}, len(values))
	result := make([]uuid.UUID, 0, len(values))
	for _, value := range values {
		if value == uuid.Nil {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func (s *Server) cleanupUnusedImages(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ImageIDs      []uuid.UUID `json:"imageIds"`
		OlderThanDays int         `json:"olderThanDays"`
		Confirm       string      `json:"confirm"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	ids := uniqueImageIDs(input.ImageIDs)
	if input.Confirm != "DELETE" || len(ids) == 0 || len(ids) > 200 {
		httpx.Error(w, r, domain.ErrInvalid)
		return
	}
	days, cutoff, err := imageCleanupCutoff(input.OlderThanDays, time.Now().UTC())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	candidates, err := s.store.ListUnusedImageArtifacts(r.Context(), cutoff)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	eligible := make(map[uuid.UUID]domain.ImageArtifact, len(candidates))
	for _, item := range candidates {
		eligible[item.ID] = item
	}
	deleted, skipped, failed := 0, 0, 0
	var freedBytes int64
	for _, id := range ids {
		item, ok := eligible[id]
		if !ok {
			skipped++
			continue
		}
		if deleteErr := s.images.DeleteUnused(r.Context(), id, cutoff); deleteErr != nil {
			if errors.Is(deleteErr, domain.ErrConflict) || errors.Is(deleteErr, domain.ErrNotFound) {
				skipped++
			} else {
				failed++
			}
			continue
		}
		deleted++
		freedBytes += item.SizeBytes
	}
	actor, _ := auth.ActorFrom(r.Context())
	result := "success"
	if failed > 0 {
		result = "failure"
	}
	changes := map[string]any{"olderThanDays": days, "requestedCount": len(ids), "deletedCount": deleted, "skippedCount": skipped, "failedCount": failed, "freedBytes": freedBytes}
	_ = s.auditWithChanges(r, actor, "image.cleanup", "image", nil, "", nil, result, "", changes)
	httpx.JSON(w, http.StatusOK, map[string]any{"deletedCount": deleted, "skippedCount": skipped, "failedCount": failed, "freedBytes": freedBytes})
}

func (s *Server) beginImageUpload(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Filename   string `json:"filename"`
		TotalBytes int64  `json:"totalBytes"`
		SHA256     string `json:"sha256"`
	}
	if err := httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	upload, err := s.images.Begin(r.Context(), actor.User.ID, input.Filename, input.TotalBytes, input.SHA256)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	_ = s.audit(r, actor, "image.upload.begin", "image_upload", &upload.ID, input.Filename, nil, "success", "")
	httpx.JSON(w, http.StatusCreated, upload)
}
func (s *Server) getImageUpload(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	item, err := s.store.GetUpload(r.Context(), id)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	if item.CreatedBy != actor.User.ID {
		httpx.Error(w, r, domain.ErrForbidden)
		return
	}
	httpx.JSON(w, http.StatusOK, item)
}
func (s *Server) uploadImageChunk(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	offset, err := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	if err != nil {
		httpx.Error(w, r, domain.ErrInvalid)
		return
	}
	length := r.ContentLength
	if length <= 0 || length > 32*1024*1024 {
		httpx.Error(w, r, domain.ErrInvalid)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	item, err := s.images.WriteChunk(r.Context(), actor.User.ID, id, offset, io.LimitReader(r.Body, length), length)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, item)
}
func (s *Server) completeImageUpload(w http.ResponseWriter, r *http.Request) {
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
	item, err := s.images.Complete(r.Context(), actor.User.ID, id, input.Name)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	_ = s.audit(r, actor, "image.upload.complete", "image", &item.ID, item.Name, nil, "success", "")
	httpx.JSON(w, http.StatusCreated, item)
}
func (s *Server) deleteImage(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	item, err := s.store.GetImageArtifact(r.Context(), id)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	if err = s.images.Delete(r.Context(), id); err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "image.delete", "image", &id, item.Name, nil, "success", "")
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}
