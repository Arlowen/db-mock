package store_test

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pika/db-mock/internal/db"
	"github.com/pika/db-mock/internal/store"
)

func TestRuntimeConfigurationPersistsAndRollsBackAutomaticRestart(t *testing.T) {
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
	schema := "instance_runtime_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, `DROP SCHEMA `+schema+` CASCADE`)
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

	userID, hostID, templateID, versionID, instanceID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	seed := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,username,password_hash) VALUES($1,'runtime-test','hash')`, []any{userID}},
		{`INSERT INTO hosts(id,name,ssh_address,ssh_user,auth_type,encrypted_credential,connection_address,
            data_root,status,cpu_count,memory_bytes,disk_free_bytes)
            VALUES($1,'host','127.0.0.1','tester','password','sealed','127.0.0.1','/opt/dbmock','online',8,17179869184,107374182400)`, []any{hostID}},
		{`INSERT INTO templates(id,slug,name,name_zh,category,tier) VALUES($1,'runtime-postgres','PostgreSQL','PostgreSQL','sql','standard')`, []any{templateID}},
		{`INSERT INTO template_versions(id,template_id,version,image_reference,min_cpu,min_memory_bytes,
            min_disk_bytes,default_port,compose_template) VALUES($1,$2,'17','postgres:17',1,1073741824,
            10737418240,5432,'services: {}')`, []any{versionID, templateID}},
		{`INSERT INTO instances(id,name,host_id,template_version_id,status,desired_state,auto_restart,cpu,
            memory_bytes,reserved_disk_bytes,host_port,container_port,database_username,encrypted_password,
            compose_project,remote_directory,configuration)
            VALUES($1,'runtime-db',$2,$3,'running','running',false,1,1073741824,10737418240,25432,5432,
            'postgres','sealed',$4,$5,$6)`, []any{instanceID, hostID, versionID,
			"dbmock_" + strings.ReplaceAll(instanceID.String(), "-", ""),
			"/opt/dbmock/instances/" + instanceID.String(), json.RawMessage(`{"extraEnvironment":{}}`)}},
	}
	for _, statement := range seed {
		if _, err = pool.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	target := store.New(pool)
	resourceID := instanceID
	configuration := store.InstanceRuntimeConfiguration{CPU: 1, MemoryBytes: 1073741824,
		ReservedDiskBytes: 10737418240, Configuration: json.RawMessage(`{"extraEnvironment":{}}`), AutoRestart: true}
	task, err := target.CreateInstanceReconfigureTask(ctx, store.TaskInput{Kind: "instance.reconfigure",
		ResourceType: "instance", ResourceID: &resourceID, RequestedBy: userID, HostID: &hostID,
		Payload: map[string]any{"instanceId": instanceID}}, instanceID, "running", configuration)
	if err != nil {
		t.Fatal(err)
	}
	instance, err := target.GetInstance(ctx, instanceID)
	if err != nil || task.Status != "queued" || instance.Status != "reconfiguring" || !instance.AutoRestart {
		t.Fatalf("queued configuration = task:%#v instance:%#v err:%v", task, instance, err)
	}
	if err = target.FinishInstanceRuntimeConfiguration(ctx, instanceID, configuration, "running", "running", ""); err != nil {
		t.Fatal(err)
	}
	instance, err = target.GetInstance(ctx, instanceID)
	if err != nil || !instance.AutoRestart || instance.Status != "running" {
		t.Fatalf("finished configuration = %#v, err=%v", instance, err)
	}

	previous := configuration
	previous.AutoRestart = false
	if err = target.FinishInstanceRuntimeConfiguration(ctx, instanceID, previous, "running", "running", "restored"); err != nil {
		t.Fatal(err)
	}
	if err = target.ReserveInstanceRuntimeConfiguration(ctx, instanceID, configuration); err != nil {
		t.Fatal(err)
	}
	instance, err = target.GetInstance(ctx, instanceID)
	if err != nil || !instance.AutoRestart || instance.Status != "reconfiguring" {
		t.Fatalf("reserved retry configuration = %#v, err=%v", instance, err)
	}
	if err = target.FinishInstanceRuntimeConfiguration(ctx, instanceID, previous, "running", "running", "restored"); err != nil {
		t.Fatal(err)
	}
	instance, err = target.GetInstance(ctx, instanceID)
	if err != nil || instance.AutoRestart || instance.StatusMessage != "restored" {
		t.Fatalf("rolled-back configuration = %#v, err=%v", instance, err)
	}
}
