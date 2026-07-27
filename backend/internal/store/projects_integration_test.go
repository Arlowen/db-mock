package store_test

import (
	"encoding/json"
	"testing"

	"github.com/pika/db-mock/internal/store"
)

func TestProjectDeploymentDefaultsPersistAndCanBeCleared(t *testing.T) {
	ctx, pool := openInstanceStoreTest(t)
	target := store.New(pool)
	environment, expiryDays := "testing", 14
	created, err := target.CreateProject(ctx, store.ProjectInput{
		Name:               "Orders",
		Description:        "Orders test databases",
		Color:              "#2563eb",
		DefaultEnvironment: &environment,
		DefaultExpiryDays:  &expiryDays,
		DefaultLabels:      json.RawMessage(`{"team":"orders","managed":"qa"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if created.DefaultEnvironment == nil || *created.DefaultEnvironment != "testing" ||
		created.DefaultExpiryDays == nil || *created.DefaultExpiryDays != 14 {
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

	retainIndefinitely := 0
	updated, err := target.UpdateProject(ctx, created.ID, store.ProjectInput{
		Name: "Orders", Description: created.Description, Color: created.Color,
		DefaultExpiryDays: &retainIndefinitely, DefaultLabels: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.DefaultEnvironment != nil || updated.DefaultExpiryDays == nil || *updated.DefaultExpiryDays != 0 ||
		string(updated.DefaultLabels) != `{}` {
		t.Fatalf("updated project defaults = %#v", updated)
	}
}
