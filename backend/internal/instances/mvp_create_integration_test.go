package instances

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"testing"

	"github.com/google/uuid"
	appcrypto "github.com/pika/db-mock/internal/crypto"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/hostops"
	"github.com/pika/db-mock/internal/store"
	"github.com/pika/db-mock/internal/tasks"
)

type mvpCreateRunner struct{}

func (mvpCreateRunner) Probe(context.Context, domain.Host) (hostops.ProbeResult, error) {
	return hostops.ProbeResult{}, nil
}

func (mvpCreateRunner) Run(context.Context, domain.Host, string, io.Reader) (hostops.CommandResult, error) {
	return hostops.CommandResult{}, nil
}

func (mvpCreateRunner) WriteFile(context.Context, domain.Host, string, []byte, os.FileMode) error {
	return nil
}

func (mvpCreateRunner) UploadFile(context.Context, domain.Host, string, string, func(int64, int64)) error {
	return nil
}

func TestMVPCreateOnlyAcceptsBuiltinStandardTemplatesAndDerivesHiddenValues(t *testing.T) {
	ctx, pool := openCancellationTest(t)
	userID, hostID := uuid.New(), uuid.New()
	standardTemplateID, experimentalTemplateID, customTemplateID := uuid.New(), uuid.New(), uuid.New()
	standardVersionID, experimentalVersionID, customVersionID := uuid.New(), uuid.New(), uuid.New()
	manifest := `{"username":"dbmock","database":"app","authentication":"password"}`
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,username,password_hash) VALUES($1,'mvp-create-admin','hash')`, []any{userID}},
		{`INSERT INTO hosts(id,name,ssh_address,ssh_user,auth_type,encrypted_credential,connection_address,
			data_root,status,architecture,cpu_count,memory_bytes,disk_free_bytes,port_start,port_end,maintenance,auto_restart_default)
			VALUES($1,'mvp-create-host','127.0.0.1','tester','password','sealed','127.0.0.1','/opt/dbmock',
			'online','amd64',8,17179869184,107374182400,25000,25010,true,false)`, []any{hostID}},
		{`INSERT INTO templates(id,slug,name,name_zh,category,tier,builtin) VALUES
			($1,'postgresql-mvp','PostgreSQL','PostgreSQL','relational','standard',true),
			($2,'tidb-experimental','TiDB','TiDB','relational','experimental',true),
			($3,'team-custom','Team DB','Team DB','relational','custom',false)`, []any{standardTemplateID, experimentalTemplateID, customTemplateID}},
		{`INSERT INTO template_versions(id,template_id,version,image_reference,architectures,min_cpu,
			min_memory_bytes,min_disk_bytes,default_port,compose_template,manifest,selectable)
			VALUES($1,$2,'17','postgres:17',ARRAY['amd64'],1,1073741824,10737418240,5432,'services: {}',$7,true),
			($3,$4,'8.5','tidb:8.5',ARRAY['amd64'],1,1073741824,10737418240,4000,'services: {}',$7,true),
			($5,$6,'1.0','team:1',ARRAY['amd64'],1,1073741824,10737418240,5432,'services: {}',$7,true)`,
			[]any{standardVersionID, standardTemplateID, experimentalVersionID, experimentalTemplateID, customVersionID, customTemplateID, manifest}},
	} {
		if _, err := pool.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	target := store.New(pool)
	vault, err := appcrypto.NewVault(bytes.Repeat([]byte{9}, 32))
	if err != nil {
		t.Fatal(err)
	}
	manager := tasks.New(target, slog.New(slog.NewTextHandler(io.Discard, nil)), 1)
	service := NewService(target, vault, hostops.NewDocker(mvpCreateRunner{}), manager)
	for name, versionID := range map[string]uuid.UUID{"experimental": experimentalVersionID, "custom": customVersionID} {
		_, _, err = service.Create(ctx, userID, CreateRequest{Name: name, TemplateVersionID: versionID})
		if !errors.Is(err, domain.ErrConflict) {
			t.Fatalf("%s template should be rejected, got %v", name, err)
		}
	}

	instance, task, err := service.Create(ctx, userID, CreateRequest{Name: "orders_test", TemplateVersionID: standardVersionID})
	if err != nil {
		t.Fatal(err)
	}
	if instance.ProjectID != nil || instance.Environment != "development" || instance.Purpose != "" || instance.Owner != "" || instance.ExpiresAt != nil {
		t.Fatalf("retired metadata was not derived to neutral defaults: %#v", instance)
	}
	if instance.HostID != hostID || instance.HostPort < 25000 || instance.HostPort > 25010 || instance.BindAddress != "0.0.0.0" {
		t.Fatalf("host placement defaults = %#v", instance)
	}
	if instance.DatabaseUsername != "dbmock" || instance.DatabaseName != "app" || !instance.AutoRestart {
		t.Fatalf("template and host defaults = %#v", instance)
	}
	var labels map[string]string
	if err = json.Unmarshal(instance.Labels, &labels); err != nil || len(labels) != 0 {
		t.Fatalf("labels = %s, %v", instance.Labels, err)
	}
	var configuration instanceConfiguration
	if err = json.Unmarshal(instance.Configuration, &configuration); err != nil {
		t.Fatal(err)
	}
	if configuration.ImageArtifactID != nil || configuration.RegistryID != nil || len(configuration.ExtraEnvironment) != 0 {
		t.Fatalf("retired deployment sources persisted: %#v", configuration)
	}
	var payload ActionPayload
	if err = tasks.DecodePayload(task, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.InstanceID != instance.ID || payload.ImageArtifactID != nil || payload.RegistryID != nil {
		t.Fatalf("task payload contains retired sources: %#v", payload)
	}
}
