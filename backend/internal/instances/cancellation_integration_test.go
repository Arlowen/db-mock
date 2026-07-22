package instances

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pika/db-mock/internal/db"
	"github.com/pika/db-mock/internal/store"
	"github.com/pika/db-mock/internal/tasks"
)

func openCancellationTest(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	databaseURL := os.Getenv("DBMOCK_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DBMOCK_TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := "instance_cancel_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		_, _ = admin.Exec(ctx, `DROP SCHEMA `+schema+` CASCADE`)
		admin.Close()
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	pool, err := db.Open(ctx, parsed.String())
	if err != nil {
		_, _ = admin.Exec(ctx, `DROP SCHEMA `+schema+` CASCADE`)
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		_, _ = admin.Exec(ctx, `DROP SCHEMA `+schema+` CASCADE`)
		admin.Close()
	})
	return ctx, pool
}

func TestQueuedStopCancellationRestoresTheStableInstanceState(t *testing.T) {
	ctx, pool := openCancellationTest(t)
	userID, hostID, templateID, versionID, instanceID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	seed := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,username,password_hash) VALUES($1,'cancel-instance-worker','hash')`, []any{userID}},
		{`INSERT INTO hosts(id,name,ssh_address,ssh_user,auth_type,encrypted_credential,connection_address,
            data_root,status) VALUES($1,'cancel-host','127.0.0.1','tester','password','sealed','127.0.0.1',
            '/opt/dbmock','online')`, []any{hostID}},
		{`INSERT INTO templates(id,slug,name,name_zh,category,tier)
            VALUES($1,'cancel-postgres','PostgreSQL','PostgreSQL','sql','standard')`, []any{templateID}},
		{`INSERT INTO template_versions(id,template_id,version,image_reference,min_cpu,min_memory_bytes,
            min_disk_bytes,default_port,compose_template) VALUES($1,$2,'17','postgres:17',1,1073741824,
            10737418240,5432,'services: {}')`, []any{versionID, templateID}},
		{`INSERT INTO instances(id,name,host_id,template_version_id,status,desired_state,cpu,memory_bytes,
            reserved_disk_bytes,host_port,container_port,database_username,encrypted_password,compose_project,
            remote_directory,configuration) VALUES($1,'cancel-db',$2,$3,'running','running',1,1073741824,
            10737418240,25432,5432,'postgres','sealed',$4,$5,$6)`, []any{instanceID, hostID, versionID,
			"dbmock_" + strings.ReplaceAll(instanceID.String(), "-", ""),
			"/opt/dbmock/instances/" + instanceID.String(), json.RawMessage(`{"extraEnvironment":{}}`)}},
	}
	for _, statement := range seed {
		if _, err := pool.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	target := store.New(pool)
	resourceID := instanceID
	task, err := target.CreateInstanceActionTask(ctx, store.TaskInput{Kind: "instance.stop", ResourceType: "instance",
		ResourceID: &resourceID, RequestedBy: userID, HostID: &hostID,
		Payload: ActionPayload{InstanceID: instanceID, PreviousStatus: "running", PreviousDesiredState: "running"}},
		instanceID, "running", "stopping")
	if err != nil {
		t.Fatal(err)
	}
	if err = target.RequestTaskCancel(ctx, task.ID); err != nil {
		t.Fatal(err)
	}

	manager := tasks.New(target, slog.New(slog.NewTextHandler(io.Discard, nil)), 1)
	NewService(target, nil, nil, manager)
	workerContext, cancelWorkers := context.WithCancel(ctx)
	if err = manager.Start(workerContext); err != nil {
		cancelWorkers()
		t.Fatal(err)
	}
	manager.Wake()
	t.Cleanup(func() {
		cancelWorkers()
		manager.Wait()
	})

	deadline := time.Now().Add(5 * time.Second)
	for {
		finished, getErr := target.GetTask(ctx, task.ID)
		if getErr != nil {
			t.Fatal(getErr)
		}
		if finished.Status == "canceled" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("queued cancellation did not finish: %#v", finished)
		}
		time.Sleep(10 * time.Millisecond)
	}
	instance, err := target.GetInstance(ctx, instanceID)
	if err != nil {
		t.Fatal(err)
	}
	if instance.Status != "running" || instance.DesiredState != "running" || instance.StatusMessage != "" {
		t.Fatalf("instance after queued stop cancellation = %#v", instance)
	}
}
