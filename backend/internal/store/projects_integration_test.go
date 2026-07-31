package store_test

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

func TestProjectDeploymentDefaultsPersistAndCanBeCleared(t *testing.T) {
	ctx, pool := openInstanceStoreTest(t)
	target := store.New(pool)
	templateID, versionID := uuid.New(), uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO templates(id,slug,name,name_zh,category,tier)
		VALUES($1,'project-postgres','PostgreSQL','PostgreSQL','sql','standard')`, templateID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO template_versions(id,template_id,version,image_reference,min_cpu,
		min_memory_bytes,min_disk_bytes,default_port,compose_template)
		VALUES($1,$2,'17','postgres:17',1,1073741824,10737418240,5432,'services: {}')`, versionID, templateID); err != nil {
		t.Fatal(err)
	}
	environment, expiryDays := "testing", 14
	cpu, memoryBytes, diskBytes := 2.0, int64(4294967296), int64(21474836480)
	created, err := target.CreateProject(ctx, store.ProjectInput{
		Name: "Orders", Description: "Orders test databases", Color: "#2563eb",
		DefaultEnvironment: &environment, DefaultExpiryDays: &expiryDays,
		DefaultLabels:            json.RawMessage(`{"team":"orders","managed":"qa"}`),
		DefaultTemplateVersionID: &versionID, DefaultCPU: &cpu,
		DefaultMemoryBytes: &memoryBytes, DefaultDiskBytes: &diskBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.DefaultEnvironment == nil || *created.DefaultEnvironment != "testing" ||
		created.DefaultExpiryDays == nil || *created.DefaultExpiryDays != 14 ||
		created.DefaultTemplateVersionID == nil || *created.DefaultTemplateVersionID != versionID ||
		created.DefaultCPU == nil || *created.DefaultCPU != 2 ||
		created.DefaultTemplateName == nil || *created.DefaultTemplateName != "PostgreSQL" ||
		created.DefaultTemplateVersion == nil || *created.DefaultTemplateVersion != "17" {
		t.Fatalf("created project defaults = %#v", created)
	}

	listed, err := target.ListProjects(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 {
		t.Fatalf("listed projects = %#v", listed)
	}
	var labels map[string]string
	if err = json.Unmarshal(listed[0].DefaultLabels, &labels); err != nil || labels["team"] != "orders" || labels["managed"] != "qa" {
		t.Fatalf("listed project labels = %s, err = %v", listed[0].DefaultLabels, err)
	}
	if listed[0].DefaultMemoryBytes == nil || *listed[0].DefaultMemoryBytes != memoryBytes ||
		listed[0].DefaultDiskBytes == nil || *listed[0].DefaultDiskBytes != diskBytes {
		t.Fatalf("listed deployment profile = %#v", listed[0])
	}

	belowMinimum := 0.5
	if _, err = target.UpdateProject(ctx, created.ID, store.ProjectInput{
		Name: created.Name, Description: created.Description, Color: created.Color,
		DefaultLabels: json.RawMessage(`{}`), DefaultTemplateVersionID: &versionID,
		DefaultCPU: &belowMinimum, DefaultMemoryBytes: &memoryBytes, DefaultDiskBytes: &diskBytes,
	}); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("below-minimum profile error = %v, want invalid input", err)
	}
	if _, err = pool.Exec(ctx, `UPDATE template_versions SET selectable=false WHERE id=$1`, versionID); err != nil {
		t.Fatal(err)
	}
	if _, err = target.UpdateProject(ctx, created.ID, store.ProjectInput{
		Name: created.Name, Description: created.Description, Color: created.Color,
		DefaultLabels: json.RawMessage(`{}`), DefaultTemplateVersionID: &versionID,
		DefaultCPU: &cpu, DefaultMemoryBytes: &memoryBytes, DefaultDiskBytes: &diskBytes,
	}); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("unavailable-template profile error = %v, want invalid input", err)
	}
	if _, err = pool.Exec(ctx, `UPDATE template_versions SET selectable=true WHERE id=$1`, versionID); err != nil {
		t.Fatal(err)
	}

	retainIndefinitely := 0
	updated, err := target.UpdateProject(ctx, created.ID, store.ProjectInput{
		Name: "Orders", Description: created.Description, Color: created.Color,
		DefaultExpiryDays: &retainIndefinitely, DefaultLabels: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.DefaultEnvironment != nil || updated.DefaultExpiryDays == nil || *updated.DefaultExpiryDays != 0 ||
		string(updated.DefaultLabels) != `{}` || updated.DefaultTemplateVersionID != nil ||
		updated.DefaultCPU != nil || updated.DefaultMemoryBytes != nil || updated.DefaultDiskBytes != nil {
		t.Fatalf("updated project defaults = %#v", updated)
	}

	updated, err = target.UpdateProject(ctx, created.ID, store.ProjectInput{
		Name: created.Name, Description: created.Description, Color: created.Color,
		DefaultLabels: json.RawMessage(`{}`), DefaultTemplateVersionID: &versionID,
		DefaultCPU: &cpu, DefaultMemoryBytes: &memoryBytes, DefaultDiskBytes: &diskBytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `DELETE FROM template_versions WHERE id=$1`, versionID); err != nil {
		t.Fatal(err)
	}
	updated, err = target.GetProject(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.DefaultTemplateVersionID != nil || updated.DefaultCPU != nil ||
		updated.DefaultMemoryBytes != nil || updated.DefaultDiskBytes != nil {
		t.Fatalf("deleted template version left a project deployment profile = %#v", updated)
	}
}
