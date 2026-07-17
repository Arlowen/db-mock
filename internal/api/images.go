package api

import (
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/pika/db-mock/internal/auth"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/httpx"
)

func (s *Server) imageRoutes(r chi.Router) {
	r.Get("/", s.listImages)
	r.Delete("/{id}", s.deleteImage)
	r.Post("/uploads", s.beginImageUpload)
	r.Get("/uploads/{id}", s.getImageUpload)
	r.Put("/uploads/{id}/chunk", s.uploadImageChunk)
	r.Post("/uploads/{id}/complete", s.completeImageUpload)
}
func (s *Server) listImages(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListImageArtifacts(r.Context())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
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
	if err = s.images.Delete(r.Context(), id); err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "image.delete", "image", &id, "", nil, "success", "")
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}
