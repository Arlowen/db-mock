package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/pika/db-mock/internal/httpx"
	platformsettings "github.com/pika/db-mock/internal/settings"
)

func (s *Server) settingRoutes(r chi.Router) {
	r.Get("/", s.getSettings)
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.GetSettings(r.Context())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]json.RawMessage{
		"timezone": timezoneSettingView(items["timezone"], s.config.Timezone),
	})
}

func timezoneSettingView(value json.RawMessage, fallback string) json.RawMessage {
	result, _ := json.Marshal(platformsettings.EffectiveTimezone(value, fallback))
	return result
}
