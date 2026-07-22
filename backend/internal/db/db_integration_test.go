package db_test

import (
	"context"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pika/db-mock/internal/db"
)

func TestUserRoleMigrationPreservesLegacyAccessAndDefaultsNewUsersToViewer(t *testing.T) {
	databaseURL := os.Getenv("DBMOCK_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DBMOCK_TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := "role_migration_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, `DROP SCHEMA `+schema+` CASCADE`)
	if _, err = admin.Exec(ctx, `CREATE TABLE `+schema+`.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		t.Fatal(err)
	}
	if _, err = admin.Exec(ctx, `CREATE TABLE `+schema+`.users (id uuid PRIMARY KEY, username text NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if _, err = admin.Exec(ctx, `INSERT INTO `+schema+`.users(id,username) VALUES($1,'legacy-admin')`, uuid.New()); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"001_initial.sql", "002_registry_probe_details.sql", "003_alert_handlers.sql",
		"004_active_resource_tasks.sql", "005_monitoring_alert_controls.sql",
		"006_template_version_risk_reports.sql", "007_task_image_source_references.sql",
		"008_instance_backups.sql", "009_host_preflight.sql", "010_instance_backup_policies.sql",
		"012_template_version_selectability.sql",
	} {
		if _, err = admin.Exec(ctx, `INSERT INTO `+schema+`.schema_migrations(name) VALUES($1)`, name); err != nil {
			t.Fatal(err)
		}
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	pool, err := db.Open(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	var legacyRole string
	if err = pool.QueryRow(ctx, `SELECT role FROM users WHERE username='legacy-admin'`).Scan(&legacyRole); err != nil {
		t.Fatal(err)
	}
	if legacyRole != "admin" {
		t.Fatalf("legacy account role = %q, want admin", legacyRole)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users(id,username) VALUES($1,'new-viewer')`, uuid.New()); err != nil {
		t.Fatal(err)
	}
	var newRole string
	if err = pool.QueryRow(ctx, `SELECT role FROM users WHERE username='new-viewer'`).Scan(&newRole); err != nil {
		t.Fatal(err)
	}
	if newRole != "viewer" {
		t.Fatalf("new account role = %q, want viewer", newRole)
	}
	if _, err = pool.Exec(ctx, `UPDATE users SET role='owner' WHERE username='new-viewer'`); err == nil {
		t.Fatal("unsupported role must violate the database constraint")
	}
}

func TestTemplateVersionSelectabilityMigrationDisablesBrokenOpenGaussImage(t *testing.T) {
	databaseURL := os.Getenv("DBMOCK_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DBMOCK_TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := "template_migration_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, `DROP SCHEMA `+schema+` CASCADE`)
	statements := []string{
		`CREATE TABLE ` + schema + `.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
		`CREATE TABLE ` + schema + `.templates (id uuid PRIMARY KEY, slug text NOT NULL, builtin boolean NOT NULL)`,
		`CREATE TABLE ` + schema + `.template_versions (id uuid PRIMARY KEY, template_id uuid NOT NULL REFERENCES ` + schema + `.templates(id), version text NOT NULL, image_reference text NOT NULL)`,
	}
	for _, statement := range statements {
		if _, err = admin.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	templateID := uuid.New()
	if _, err = admin.Exec(ctx, `INSERT INTO `+schema+`.templates(id,slug,builtin) VALUES($1,'opengauss',true)`, templateID); err != nil {
		t.Fatal(err)
	}
	brokenID, correctedID := uuid.New(), uuid.New()
	if _, err = admin.Exec(ctx, `INSERT INTO `+schema+`.template_versions(id,template_id,version,image_reference) VALUES
		($1,$3,'6.0.0','opengauss/opengauss:6.0.0'),($2,$3,'6.0.0-r1','enmotech/opengauss:6.0.0')`, brokenID, correctedID, templateID); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"001_initial.sql", "002_registry_probe_details.sql", "003_alert_handlers.sql",
		"004_active_resource_tasks.sql", "005_monitoring_alert_controls.sql",
		"006_template_version_risk_reports.sql", "007_task_image_source_references.sql",
		"008_instance_backups.sql", "009_host_preflight.sql", "010_instance_backup_policies.sql",
		"011_user_roles.sql",
	} {
		if _, err = admin.Exec(ctx, `INSERT INTO `+schema+`.schema_migrations(name) VALUES($1)`, name); err != nil {
			t.Fatal(err)
		}
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	pool, err := db.Open(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var brokenSelectable, correctedSelectable bool
	if err = pool.QueryRow(ctx, `SELECT selectable FROM template_versions WHERE id=$1`, brokenID).Scan(&brokenSelectable); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT selectable FROM template_versions WHERE id=$1`, correctedID).Scan(&correctedSelectable); err != nil {
		t.Fatal(err)
	}
	if brokenSelectable || !correctedSelectable {
		t.Fatalf("selectability after migration: broken=%t corrected=%t", brokenSelectable, correctedSelectable)
	}
}
