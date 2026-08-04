package instances

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	appcrypto "github.com/pika/db-mock/internal/crypto"
	"github.com/pika/db-mock/internal/db"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/hostops"
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

type cancellationFixture struct {
	userID, hostID, versionID, instanceID uuid.UUID
}

func seedCancellationFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) cancellationFixture {
	t.Helper()
	userID, hostID, templateID, versionID, instanceID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	seed := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,username,password_hash) VALUES($1,'cancel-instance-worker','hash')`, []any{userID}},
		{`INSERT INTO hosts(id,name,ssh_address,ssh_user,auth_type,encrypted_credential,connection_address,
			data_root,status,cpu_count,memory_bytes,disk_free_bytes) VALUES($1,'cancel-host','127.0.0.1',
			'tester','password','sealed','127.0.0.1','/opt/dbmock','online',8,17179869184,107374182400)`, []any{hostID}},
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
	return cancellationFixture{userID: userID, hostID: hostID, versionID: versionID, instanceID: instanceID}
}

func newCancellationManager(target *store.Store, vault *appcrypto.Vault) *tasks.Manager {
	manager := tasks.New(target, slog.New(slog.NewTextHandler(io.Discard, nil)), 1)
	NewService(target, vault, nil, manager)
	return manager
}

func TestQueuedStopCancellationFinishesImmediatelyBehindBusyHostWork(t *testing.T) {
	ctx, pool := openCancellationTest(t)
	fixture := seedCancellationFixture(t, ctx, pool)

	target := store.New(pool)
	busy, err := target.CreateTask(ctx, store.TaskInput{Kind: "host.upgrade_docker", ResourceType: "host",
		ResourceID: &fixture.hostID, RequestedBy: fixture.userID, HostID: &fixture.hostID,
		Payload: map[string]any{"hostId": fixture.hostID}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE tasks SET status='running',stage='docker',cancelable=false WHERE id=$1`, busy.ID); err != nil {
		t.Fatal(err)
	}
	resourceID := fixture.instanceID
	task, err := target.CreateInstanceActionTask(ctx, store.TaskInput{Kind: "instance.stop", ResourceType: "instance",
		ResourceID: &resourceID, RequestedBy: fixture.userID, HostID: &fixture.hostID,
		Payload: ActionPayload{InstanceID: fixture.instanceID, PreviousStatus: "running", PreviousDesiredState: "running"}},
		fixture.instanceID, "running", "stopping")
	if err != nil {
		t.Fatal(err)
	}
	finished, err := newCancellationManager(target, nil).CancelTask(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if finished.Status != "canceled" || finished.StartedAt != nil || finished.FinishedAt == nil || finished.Attempts != 0 {
		t.Fatalf("queued task was not completed without execution: %#v", finished)
	}
	instance, err := target.GetInstance(ctx, fixture.instanceID)
	if err != nil {
		t.Fatal(err)
	}
	if instance.Status != "running" || instance.DesiredState != "running" || instance.StatusMessage != "" {
		t.Fatalf("instance after queued stop cancellation = %#v", instance)
	}
	busyAfter, err := target.GetTask(ctx, busy.ID)
	if err != nil || busyAfter.Status != "running" {
		t.Fatalf("unrelated host work changed during cancellation: task=%#v err=%v", busyAfter, err)
	}
	if _, err = target.CreateInstanceActionTask(ctx, store.TaskInput{Kind: "instance.stop", ResourceType: "instance",
		ResourceID: &resourceID, RequestedBy: fixture.userID, HostID: &fixture.hostID,
		Payload: ActionPayload{InstanceID: fixture.instanceID, PreviousStatus: "running", PreviousDesiredState: "running"}},
		fixture.instanceID, "running", "stopping"); err != nil {
		t.Fatalf("canceled task did not release the instance operation slot: %v", err)
	}
}

func TestQueuedDeleteCancellationRestoresSuspendedBackupPolicy(t *testing.T) {
	ctx, pool := openCancellationTest(t)
	fixture := seedCancellationFixture(t, ctx, pool)
	nextRunAt := time.Now().UTC().Add(time.Hour).Truncate(time.Microsecond)
	if _, err := pool.Exec(ctx, `INSERT INTO instance_backup_policies(instance_id,enabled,next_run_at,configured_by)
		VALUES($1,true,$2,$3)`, fixture.instanceID, nextRunAt, fixture.userID); err != nil {
		t.Fatal(err)
	}
	target := store.New(pool)
	resourceID := fixture.instanceID
	task, err := target.CreateInstanceActionTask(ctx, store.TaskInput{Kind: "instance.delete", ResourceType: "instance",
		ResourceID: &resourceID, RequestedBy: fixture.userID, HostID: &fixture.hostID,
		Payload: ActionPayload{InstanceID: fixture.instanceID, PreviousStatus: "running", PreviousDesiredState: "running"}},
		fixture.instanceID, "running", "deleting")
	if err != nil {
		t.Fatal(err)
	}
	var suspendedEnabled bool
	var suspendedNextRunAt *time.Time
	err = pool.QueryRow(ctx, `SELECT enabled,next_run_at FROM instance_backup_policies WHERE instance_id=$1`,
		fixture.instanceID).Scan(&suspendedEnabled, &suspendedNextRunAt)
	if err != nil || suspendedEnabled || suspendedNextRunAt != nil {
		t.Fatalf("delete did not suspend the policy: enabled=%t next=%v err=%v", suspendedEnabled, suspendedNextRunAt, err)
	}
	var payload ActionPayload
	if err = json.Unmarshal(task.Payload, &payload); err != nil || payload.PreviousBackupPolicyEnabled == nil ||
		!*payload.PreviousBackupPolicyEnabled || payload.PreviousBackupPolicyNextRunAt == nil {
		t.Fatalf("delete task did not capture the policy state: payload=%s err=%v", task.Payload, err)
	}
	if _, err = newCancellationManager(target, nil).CancelTask(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	var restoredEnabled bool
	var restoredNextRunAt *time.Time
	err = pool.QueryRow(ctx, `SELECT enabled,next_run_at FROM instance_backup_policies WHERE instance_id=$1`,
		fixture.instanceID).Scan(&restoredEnabled, &restoredNextRunAt)
	if err != nil || !restoredEnabled || restoredNextRunAt == nil || !restoredNextRunAt.Equal(nextRunAt) {
		t.Fatalf("canceled delete did not restore the policy: enabled=%t next=%v err=%v", restoredEnabled, restoredNextRunAt, err)
	}
}

func TestDeleteQueueAtomicallyRejectsExistingBackups(t *testing.T) {
	ctx, pool := openCancellationTest(t)
	fixture := seedCancellationFixture(t, ctx, pool)
	backupID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO instance_backups(id,instance_id,host_id,template_version_id,
		name,status,remote_path,created_by) VALUES($1,$2,$3,$4,'cleanup-blocker','ready',$5,$6)`,
		backupID, fixture.instanceID, fixture.hostID, fixture.versionID,
		"/opt/dbmock/backups/"+backupID.String()+".tar.gz", fixture.userID); err != nil {
		t.Fatal(err)
	}
	target := store.New(pool)
	resourceID := fixture.instanceID
	_, err := target.CreateInstanceActionTask(ctx, store.TaskInput{Kind: "instance.delete", ResourceType: "instance",
		ResourceID: &resourceID, RequestedBy: fixture.userID, HostID: &fixture.hostID,
		Payload: ActionPayload{InstanceID: fixture.instanceID, PreviousStatus: "running", PreviousDesiredState: "running"}},
		fixture.instanceID, "running", "deleting")
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("delete queue error = %v, want conflict", err)
	}
	instance, getErr := target.GetInstance(ctx, fixture.instanceID)
	if getErr != nil || instance.Status != "running" {
		t.Fatalf("blocked delete changed instance state: instance=%#v err=%v", instance, getErr)
	}
	var taskCount int
	if countErr := pool.QueryRow(ctx, `SELECT count(*) FROM tasks WHERE resource_id=$1`, fixture.instanceID).
		Scan(&taskCount); countErr != nil || taskCount != 0 {
		t.Fatalf("blocked delete persisted tasks=%d err=%v", taskCount, countErr)
	}
}

func TestQueuedRetryCancellationPreservesTheCurrentResourceState(t *testing.T) {
	ctx, pool := openCancellationTest(t)
	fixture := seedCancellationFixture(t, ctx, pool)
	target := store.New(pool)
	if err := target.UpdateInstanceState(ctx, fixture.instanceID, "degraded", "running", "Original stop attempt failed"); err != nil {
		t.Fatal(err)
	}
	resourceID := fixture.instanceID
	original, err := target.CreateTask(ctx, store.TaskInput{Kind: "instance.stop", ResourceType: "instance",
		ResourceID: &resourceID, RequestedBy: fixture.userID, HostID: &fixture.hostID,
		Payload: ActionPayload{InstanceID: fixture.instanceID, PreviousStatus: "running", PreviousDesiredState: "running"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE tasks SET status='failed',stage='failed',cancelable=false,
		error_code='task_failed',error_message='stop failed',finished_at=now() WHERE id=$1`, original.ID); err != nil {
		t.Fatal(err)
	}
	retry, err := target.RetryTask(ctx, original.ID, fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = newCancellationManager(target, nil).CancelTask(ctx, retry.ID); err != nil {
		t.Fatal(err)
	}
	instance, err := target.GetInstance(ctx, fixture.instanceID)
	if err != nil || instance.Status != "degraded" || instance.DesiredState != "running" ||
		instance.StatusMessage != "Original stop attempt failed" {
		t.Fatalf("canceling an unapplied retry changed the resource: instance=%#v err=%v", instance, err)
	}
}

func TestRunningTaskCancellationRemainsPendingUntilASafeCheckpoint(t *testing.T) {
	ctx, pool := openCancellationTest(t)
	fixture := seedCancellationFixture(t, ctx, pool)
	target := store.New(pool)
	resourceID := fixture.instanceID
	queued, err := target.CreateInstanceActionTask(ctx, store.TaskInput{Kind: "instance.stop", ResourceType: "instance",
		ResourceID: &resourceID, RequestedBy: fixture.userID, HostID: &fixture.hostID,
		Payload: ActionPayload{InstanceID: fixture.instanceID, PreviousStatus: "running", PreviousDesiredState: "running"}},
		fixture.instanceID, "running", "stopping")
	if err != nil {
		t.Fatal(err)
	}
	running, err := target.ClaimTask(ctx)
	if err != nil || running.ID != queued.ID {
		t.Fatalf("claimed task = %#v, err=%v", running, err)
	}
	canceled, err := newCancellationManager(target, nil).CancelTask(ctx, running.ID)
	if err != nil {
		t.Fatal(err)
	}
	if canceled.Status != "running" || !canceled.CancelAsked || !canceled.Cancelable || canceled.FinishedAt != nil {
		t.Fatalf("running task did not retain checkpoint cancellation semantics: %#v", canceled)
	}
	instance, err := target.GetInstance(ctx, fixture.instanceID)
	if err != nil || instance.Status != "stopping" {
		t.Fatalf("running cancellation changed the resource before its handler checkpoint: instance=%#v err=%v", instance, err)
	}
}

func TestStartupRetiresUnsupportedQueuedInstanceTasksWithResourceRecovery(t *testing.T) {
	ctx, pool := openCancellationTest(t)
	fixture := seedCancellationFixture(t, ctx, pool)
	target := store.New(pool)
	resourceID := fixture.instanceID
	legacy, err := target.CreateInstanceActionTask(ctx, store.TaskInput{Kind: "instance.upgrade", ResourceType: "instance",
		ResourceID: &resourceID, RequestedBy: fixture.userID, HostID: &fixture.hostID,
		Payload: ActionPayload{InstanceID: fixture.instanceID, PreviousStatus: "running", PreviousDesiredState: "running"}},
		fixture.instanceID, "running", "upgrading")
	if err != nil {
		t.Fatal(err)
	}

	manager := newCancellationManager(target, nil)
	workerContext, stopWorkers := context.WithCancel(ctx)
	if err = manager.Start(workerContext); err != nil {
		stopWorkers()
		t.Fatal(err)
	}
	stopWorkers()
	manager.Wait()

	retired, err := target.GetTask(ctx, legacy.ID)
	if err != nil || retired.Status != "canceled" || retired.ErrorCode != "canceled" {
		t.Fatalf("legacy task was not retired safely: task=%#v err=%v", retired, err)
	}
	if _, err = manager.RetryTask(ctx, legacy.ID, fixture.userID); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("retired task retry error = %v, want conflict", err)
	}
	instance, err := target.GetInstance(ctx, fixture.instanceID)
	if err != nil || instance.Status != "running" || instance.DesiredState != "running" {
		t.Fatalf("legacy task retirement did not restore the instance: instance=%#v err=%v", instance, err)
	}
}

func TestStartupQuarantinesInterruptedUnsupportedInstanceTasks(t *testing.T) {
	ctx, pool := openCancellationTest(t)
	fixture := seedCancellationFixture(t, ctx, pool)
	target := store.New(pool)
	resourceID := fixture.instanceID
	legacy, err := target.CreateInstanceActionTask(ctx, store.TaskInput{Kind: "instance.upgrade", ResourceType: "instance",
		ResourceID: &resourceID, RequestedBy: fixture.userID, HostID: &fixture.hostID,
		Payload: ActionPayload{InstanceID: fixture.instanceID, PreviousStatus: "running", PreviousDesiredState: "running"}},
		fixture.instanceID, "running", "upgrading")
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := target.ClaimTask(ctx)
	if err != nil || claimed.ID != legacy.ID {
		t.Fatalf("claim legacy task = %#v, err=%v", claimed, err)
	}

	manager := newCancellationManager(target, nil)
	workerContext, stopWorkers := context.WithCancel(ctx)
	if err = manager.Start(workerContext); err != nil {
		stopWorkers()
		t.Fatal(err)
	}
	stopWorkers()
	manager.Wait()

	interrupted, err := target.GetTask(ctx, legacy.ID)
	if err != nil || interrupted.Status != "interrupted" || interrupted.ErrorCode != "application_restarted" {
		t.Fatalf("legacy running task was not interrupted: task=%#v err=%v", interrupted, err)
	}
	instance, err := target.GetInstance(ctx, fixture.instanceID)
	if err != nil || instance.Status != "failed" || instance.DesiredState != "stopped" || instance.StatusMessage == "" {
		t.Fatalf("interrupted legacy task was not quarantined: instance=%#v err=%v", instance, err)
	}
}

func TestStartupRetiresUnsupportedQueuedHostManagementTasks(t *testing.T) {
	ctx, pool := openCancellationTest(t)
	fixture := seedCancellationFixture(t, ctx, pool)
	target := store.New(pool)
	legacy, err := target.CreateTask(ctx, store.TaskInput{Kind: "host.upgrade_docker", ResourceType: "host",
		ResourceID: &fixture.hostID, RequestedBy: fixture.userID, HostID: &fixture.hostID,
		Payload: hostops.HostTaskPayload{HostID: fixture.hostID}})
	if err != nil {
		t.Fatal(err)
	}

	manager := tasks.New(target, slog.New(slog.NewTextHandler(io.Discard, nil)), 1)
	hostops.NewService(target, nil, manager)
	workerContext, stopWorkers := context.WithCancel(ctx)
	if err = manager.Start(workerContext); err != nil {
		stopWorkers()
		t.Fatal(err)
	}
	stopWorkers()
	manager.Wait()

	retired, err := target.GetTask(ctx, legacy.ID)
	if err != nil || retired.Status != "canceled" || retired.ErrorCode != "canceled" {
		t.Fatalf("legacy host task was not retired safely: task=%#v err=%v", retired, err)
	}
	if _, err = manager.RetryTask(ctx, legacy.ID, fixture.userID); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("retired host task retry error = %v, want conflict", err)
	}
	host, err := target.GetHost(ctx, fixture.hostID)
	if err != nil || host.Status != "online" {
		t.Fatalf("retiring an unstarted host task changed host state: host=%#v err=%v", host, err)
	}
}
