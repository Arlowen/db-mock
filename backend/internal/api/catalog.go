package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/httpx"
)

func (s *Server) templateRoutes(r chi.Router) {
	r.Get("/", s.listTemplates)
}

func mvpTemplates(items []domain.Template) []domain.Template {
	result := make([]domain.Template, 0, len(items))
	for _, item := range items {
		if !item.Builtin || item.Tier != "standard" {
			continue
		}
		versions := make([]domain.TemplateVersion, 0, len(item.Versions))
		for _, version := range item.Versions {
			if version.Selectable {
				versions = append(versions, version)
			}
		}
		if len(versions) == 0 {
			continue
		}
		item.Versions = versions
		result = append(result, item)
	}
	return result
}

func (s *Server) listTemplates(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListTemplates(r.Context())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": mvpTemplates(items)})
}
