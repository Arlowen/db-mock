package instances

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	appcrypto "github.com/pika/db-mock/internal/crypto"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/hostops"
	"github.com/pika/db-mock/internal/store"
	"github.com/pika/db-mock/internal/tasks"
)

type emptyPortRunner struct{}

func (emptyPortRunner) Probe(context.Context, domain.Host) (hostops.ProbeResult, error) {
	return hostops.ProbeResult{}, nil
}

func (emptyPortRunner) Run(context.Context, domain.Host, string, io.Reader) (hostops.CommandResult, error) {
	return hostops.CommandResult{}, nil
}

func (emptyPortRunner) WriteFile(context.Context, domain.Host, string, []byte, os.FileMode) error {
	return nil
}

func (emptyPortRunner) UploadFile(context.Context, domain.Host, string, string, func(int64, int64)) error {
	return nil
}

func TestCreateWithOfflineImageSelectsAHostWithTheArchiveArchitecture(t *testing.T) {
	ctx, pool := openCancellationTest(t)
	userID, amd64HostID, arm64HostID := uuid.New(), uuid.New(), uuid.New()
	templateID, versionID, artifactID, reservedInstanceID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,username,password_hash) VALUES($1,'offline-scheduler','hash')`, []any{userID}},
		{`INSERT INTO hosts(id,name,ssh_address,ssh_user,auth_type,encrypted_credential,connection_address,
			data_root,status,architecture,cpu_count,memory_bytes,disk_free_bytes,port_start,port_end)
			VALUES($1,'a-amd64-host','127.0.0.1','tester','password','sealed','127.0.0.1','/opt/dbmock-amd64',
			'online','amd64',8,17179869184,107374182400,25000,25010)`, []any{amd64HostID}},
		{`INSERT INTO hosts(id,name,ssh_address,ssh_user,auth_type,encrypted_credential,connection_address,
			data_root,status,architecture,cpu_count,memory_bytes,disk_free_bytes,port_start,port_end)
			VALUES($1,'b-arm64-host','127.0.0.1','tester','password','sealed','127.0.0.1','/opt/dbmock-arm64',
			'online','arm64',8,17179869184,107374182400,26000,26010)`, []any{arm64HostID}},
		{`INSERT INTO templates(id,slug,name,name_zh,category,tier)
			VALUES($1,'offline-postgres','PostgreSQL','PostgreSQL','sql','standard')`, []any{templateID}},
		{`INSERT INTO template_versions(id,template_id,version,image_reference,architectures,min_cpu,
			min_memory_bytes,min_disk_bytes,default_port,compose_template)
			VALUES($1,$2,'17','postgres:17',ARRAY['amd64','arm64'],1,1073741824,10737418240,5432,'services: {}')`, []any{versionID, templateID}},
		{`INSERT INTO image_artifacts(id,name,filename,path,size_bytes,sha256,format,image_refs,architectures,
			status,created_by) VALUES($1,'PostgreSQL arm64','postgres-arm64.tar','/tmp/postgres-arm64.tar',1024,
			$2,'docker-archive',ARRAY['postgres:17'],ARRAY['arm64'],'ready',$3)`, []any{artifactID, strings.Repeat("a", 64), userID}},
		{`INSERT INTO instances(id,name,host_id,template_version_id,status,desired_state,cpu,memory_bytes,
			reserved_disk_bytes,host_port,container_port,database_username,encrypted_password,compose_project,
			remote_directory) VALUES($1,'existing-arm64-db',$2,$3,'running','running',1,1073741824,
			10737418240,26000,5432,'postgres','sealed',$4,$5)`, []any{reservedInstanceID, arm64HostID, versionID,
			"dbmock_" + strings.ReplaceAll(reservedInstanceID.String(), "-", ""),
			"/opt/dbmock-arm64/instances/" + reservedInstanceID.String()}},
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
	service := NewService(target, vault, hostops.NewDocker(emptyPortRunner{}), manager)
	instance, task, err := service.Create(ctx, userID, CreateRequest{Name: "scheduled-arm64-db",
		TemplateVersionID: versionID, CPU: 1, MemoryBytes: 1073741824, DiskBytes: 10737418240,
		ImageArtifactID: &artifactID})
	if err != nil {
		t.Fatal(err)
	}
	if instance.HostID != arm64HostID || task.HostID == nil || *task.HostID != arm64HostID {
		t.Fatalf("offline deployment selected instance host %s and task host %v, want %s", instance.HostID, task.HostID, arm64HostID)
	}

	_, _, err = service.Create(ctx, userID, CreateRequest{Name: "invalid-amd64-db", HostID: &amd64HostID,
		TemplateVersionID: versionID, CPU: 1, MemoryBytes: 1073741824, DiskBytes: 10737418240,
		ImageArtifactID: &artifactID})
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("expected an explicitly selected host with the wrong architecture to conflict, got %v", err)
	}
}
