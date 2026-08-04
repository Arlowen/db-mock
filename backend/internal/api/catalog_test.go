package api

import (
	"testing"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

func TestMVPTemplatesOnlyReturnsSelectableBuiltinStandardVersions(t *testing.T) {
	selectableID := uuid.New()
	items := []domain.Template{
		{ID: uuid.New(), Name: "PostgreSQL", Builtin: true, Tier: "standard", Versions: []domain.TemplateVersion{
			{ID: selectableID, Selectable: true},
			{ID: uuid.New(), Selectable: false},
		}},
		{ID: uuid.New(), Name: "TiDB", Builtin: true, Tier: "experimental", Versions: []domain.TemplateVersion{{ID: uuid.New(), Selectable: true}}},
		{ID: uuid.New(), Name: "Team DB", Builtin: false, Tier: "custom", Versions: []domain.TemplateVersion{{ID: uuid.New(), Selectable: true}}},
		{ID: uuid.New(), Name: "Retired DB", Builtin: true, Tier: "standard", Versions: []domain.TemplateVersion{{ID: uuid.New(), Selectable: false}}},
	}

	filtered := mvpTemplates(items)
	if len(filtered) != 1 || filtered[0].Name != "PostgreSQL" {
		t.Fatalf("templates = %#v, want only PostgreSQL", filtered)
	}
	if len(filtered[0].Versions) != 1 || filtered[0].Versions[0].ID != selectableID {
		t.Fatalf("versions = %#v, want only the selectable version", filtered[0].Versions)
	}
	if len(items[0].Versions) != 2 {
		t.Fatal("filter must not mutate the store result")
	}
}
