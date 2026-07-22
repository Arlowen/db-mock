package store_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pika/db-mock/internal/db"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

func openInstanceStoreTest(t *testing.T) (context.Context, *pgxpool.Pool) {
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
	schema := "instance_runtime_" + strings.ReplaceAll(uuid.NewString(), "-", "")
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

func TestCreateInstanceTaskCommitsTheResourceAndTaskAtomically(t *testing.T) {
	ctx, pool := openInstanceStoreTest(t)
	userID, hostID, templateID, versionID, registryID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,username,password_hash) VALUES($1,'creator','hash')`, []any{userID}},
		{`INSERT INTO hosts(id,name,ssh_address,ssh_user,auth_type,encrypted_credential,connection_address,
            data_root,status,cpu_count,memory_bytes,disk_free_bytes,port_start,port_end)
            VALUES($1,'create-host','127.0.0.1','tester','password','sealed','127.0.0.1','/opt/dbmock',
            'online',8,17179869184,107374182400,25000,25010)`, []any{hostID}},
		{`INSERT INTO templates(id,slug,name,name_zh,category,tier)
            VALUES($1,'create-postgres','PostgreSQL','PostgreSQL','sql','standard')`, []any{templateID}},
		{`INSERT INTO template_versions(id,template_id,version,image_reference,min_cpu,min_memory_bytes,
            min_disk_bytes,default_port,compose_template) VALUES($1,$2,'17','postgres:17',1,1073741824,
            10737418240,5432,'services: {}')`, []any{versionID, templateID}},
		{`INSERT INTO registries(id,name,url) VALUES($1,'create-registry','https://registry.example.com')`, []any{registryID}},
	} {
		if _, err := pool.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	target := store.New(pool)
	input := func(id uuid.UUID, name string, port int) store.InstanceInput {
		return store.InstanceInput{ID: id, Name: name, HostID: hostID, TemplateVersionID: versionID,
			Environment: "development", AutoRestart: true, CPU: 1, MemoryBytes: 1073741824,
			ReservedDiskBytes: 10737418240, HostPort: port, ContainerPort: 5432, BindAddress: "0.0.0.0",
			DatabaseUsername: "dbmock", EncryptedPassword: "sealed", DatabaseName: "app",
			ComposeProject:  "dbmock_" + strings.ReplaceAll(id.String(), "-", ""),
			RemoteDirectory: "/opt/dbmock/instances/" + id.String(), Configuration: json.RawMessage(`{"extraEnvironment":{}}`)}
	}

	instanceID := uuid.New()
	atomicInput := input(instanceID, "atomic-db", 25000)
	atomicInput.Configuration = json.RawMessage(`{"extraEnvironment":{},"registryId":"` + registryID.String() + `"}`)
	instance, task, err := target.CreateInstanceTask(ctx, atomicInput, store.TaskInput{
		RequestedBy: userID, Payload: map[string]any{"instanceId": instanceID, "registryId": registryID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if instance.ID != instanceID || instance.Status != "provisioning" || task.Kind != "instance.create" ||
		task.Status != "queued" || task.ResourceID == nil || *task.ResourceID != instanceID ||
		task.HostID == nil || *task.HostID != hostID {
		t.Fatalf("atomic create returned instance=%#v task=%#v", instance, task)
	}
	if _, err = target.GetInstance(ctx, instanceID); err != nil {
		t.Fatalf("committed instance is unavailable: %v", err)
	}
	if _, err = target.GetTask(ctx, task.ID); err != nil {
		t.Fatalf("committed task is unavailable: %v", err)
	}
	var references struct {
		RegistryID *uuid.UUID `json:"registryId"`
	}
	if err = json.Unmarshal(task.Payload, &references); err != nil || references.RegistryID == nil || *references.RegistryID != registryID {
		t.Fatalf("create task did not retain the selected image source: payload=%s err=%v", task.Payload, err)
	}

	rolledBackID := uuid.New()
	_, _, err = target.CreateInstanceTask(ctx, input(rolledBackID, "rolled-back-db", 25001), store.TaskInput{
		RequestedBy: uuid.New(), Payload: map[string]any{"instanceId": rolledBackID},
	})
	if err == nil {
		t.Fatal("expected the invalid task requester to make the transaction fail")
	}
	if _, getErr := target.GetInstance(ctx, rolledBackID); !errors.Is(getErr, domain.ErrNotFound) {
		t.Fatalf("instance survived a failed task insert: %v", getErr)
	}
	var taskCount int
	if countErr := pool.QueryRow(ctx, `SELECT count(*) FROM tasks WHERE resource_id=$1`, rolledBackID).Scan(&taskCount); countErr != nil || taskCount != 0 {
		t.Fatalf("task rows after rollback = %d, %v", taskCount, countErr)
	}
	retried, retryTask, err := target.CreateInstanceTask(ctx, input(rolledBackID, "rolled-back-db", 25001), store.TaskInput{
		RequestedBy: userID, Payload: map[string]any{"instanceId": rolledBackID},
	})
	if err != nil || retried.ID != rolledBackID || retryTask.ResourceID == nil || *retryTask.ResourceID != rolledBackID {
		t.Fatalf("rolled-back name, port, and capacity were not reusable: instance=%#v task=%#v err=%v", retried, retryTask, err)
	}
}

func TestRuntimeConfigurationPersistsAndRollsBackAutomaticRestart(t *testing.T) {
	ctx, pool := openInstanceStoreTest(t)

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
		if _, err := pool.Exec(ctx, statement.query, statement.args...); err != nil {
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

func TestListInstanceMetricsSamplesTheWholeRequestedWindow(t *testing.T) {
	ctx, pool := openInstanceStoreTest(t)
	hostID, templateID, versionID, instanceID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO hosts(id,name,ssh_address,ssh_user,auth_type,encrypted_credential,connection_address,
            data_root,status) VALUES($1,'metric-host','127.0.0.1','tester','password','sealed','127.0.0.1',
            '/opt/dbmock','online')`, []any{hostID}},
		{`INSERT INTO templates(id,slug,name,name_zh,category,tier)
            VALUES($1,'metric-postgres','PostgreSQL','PostgreSQL','sql','standard')`, []any{templateID}},
		{`INSERT INTO template_versions(id,template_id,version,image_reference,min_cpu,min_memory_bytes,
            min_disk_bytes,default_port,compose_template) VALUES($1,$2,'17','postgres:17',1,1073741824,
            10737418240,5432,'services: {}')`, []any{versionID, templateID}},
		{`INSERT INTO instances(id,name,host_id,template_version_id,status,desired_state,cpu,memory_bytes,
            reserved_disk_bytes,host_port,container_port,database_username,encrypted_password,compose_project,
            remote_directory) VALUES($1,'metric-db',$2,$3,'running','running',1,1073741824,10737418240,
            25432,5432,'postgres','sealed',$4,$5)`, []any{instanceID, hostID, versionID,
			"dbmock_" + strings.ReplaceAll(instanceID.String(), "-", ""), "/opt/dbmock/instances/" + instanceID.String()}},
	} {
		if _, err := pool.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	start := time.Date(2026, 7, 22, 8, 0, 0, 0, time.UTC)
	if _, err := pool.Exec(ctx, `INSERT INTO metric_samples(host_id,instance_id,cpu_percent,memory_percent,
        disk_used_bytes,disk_total_bytes,collected_at)
        SELECT $1,$2,number,number,number*1024,102400,$3::timestamptz+number*interval '1 minute'
        FROM generate_series(0,9) AS number`, hostID, instanceID, start); err != nil {
		t.Fatal(err)
	}

	items, err := store.New(pool).ListInstanceMetrics(ctx, instanceID, start.Add(-time.Second), 4)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 4 {
		t.Fatalf("sample count = %d, want 4", len(items))
	}
	wantTimes := []time.Time{start, start.Add(3 * time.Minute), start.Add(6 * time.Minute), start.Add(9 * time.Minute)}
	for index, item := range items {
		if !item.CollectedAt.Equal(wantTimes[index]) {
			t.Fatalf("sample %d time = %s, want %s", index, item.CollectedAt, wantTimes[index])
		}
	}

	all, err := store.New(pool).ListInstanceMetrics(ctx, instanceID, start.Add(-time.Second), 20)
	if err != nil || len(all) != 10 {
		t.Fatalf("unsampled metrics = %d, %v", len(all), err)
	}
}
