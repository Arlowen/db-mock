package instances

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	appcrypto "github.com/pika/db-mock/internal/crypto"
	"github.com/pika/db-mock/internal/db"
	"github.com/pika/db-mock/internal/domain"
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

func TestQueuedReconfigurationCancellationRestoresReservedConfiguration(t *testing.T) {
	ctx, pool := openCancellationTest(t)
	fixture := seedCancellationFixture(t, ctx, pool)
	target := store.New(pool)
	vault, err := appcrypto.NewVault(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	previousJSON := json.RawMessage(`{"extraEnvironment":{"OLD":"1"}}`)
	if _, err = pool.Exec(ctx, `UPDATE instances SET configuration=$2,auto_restart=false WHERE id=$1`, fixture.instanceID, previousJSON); err != nil {
		t.Fatal(err)
	}
	encryptedPrevious, err := vault.Seal(previousJSON, runtimeConfigurationContext(fixture.instanceID))
	if err != nil {
		t.Fatal(err)
	}
	targetConfiguration := store.InstanceRuntimeConfiguration{CPU: 2, MemoryBytes: 2147483648,
		ReservedDiskBytes: 21474836480, Configuration: json.RawMessage(`{"extraEnvironment":{"NEW":"1"}}`), AutoRestart: true}
	resourceID := fixture.instanceID
	previousAutoRestart := false
	task, err := target.CreateInstanceReconfigureTask(ctx, store.TaskInput{Kind: "instance.reconfigure",
		ResourceType: "instance", ResourceID: &resourceID, RequestedBy: fixture.userID, HostID: &fixture.hostID,
		Payload: ActionPayload{InstanceID: fixture.instanceID, PreviousStatus: "running", PreviousDesiredState: "running",
			PreviousCPU: 1, PreviousMemoryBytes: 1073741824, PreviousDiskBytes: 10737418240,
			EncryptedPreviousConfig: encryptedPrevious, PreviousAutoRestart: &previousAutoRestart}},
		fixture.instanceID, "running", targetConfiguration)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = newCancellationManager(target, vault).CancelTask(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	instance, err := target.GetInstance(ctx, fixture.instanceID)
	if err != nil {
		t.Fatal(err)
	}
	if instance.Status != "running" || instance.CPU != 1 || instance.MemoryBytes != 1073741824 ||
		instance.ReservedDiskBytes != 10737418240 || instance.AutoRestart || !sameJSON(instance.Configuration, previousJSON) {
		t.Fatalf("queued configuration reservation was not restored: %#v", instance)
	}
}

func sameJSON(left, right []byte) bool {
	var leftValue, rightValue any
	return json.Unmarshal(left, &leftValue) == nil && json.Unmarshal(right, &rightValue) == nil &&
		reflect.DeepEqual(leftValue, rightValue)
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
	suspended, err := target.GetInstanceBackupPolicy(ctx, fixture.instanceID)
	if err != nil || suspended.Enabled || suspended.NextRunAt != nil {
		t.Fatalf("delete did not suspend the policy: policy=%#v err=%v", suspended, err)
	}
	var payload ActionPayload
	if err = json.Unmarshal(task.Payload, &payload); err != nil || payload.PreviousBackupPolicyEnabled == nil ||
		!*payload.PreviousBackupPolicyEnabled || payload.PreviousBackupPolicyNextRunAt == nil {
		t.Fatalf("delete task did not capture the policy state: payload=%s err=%v", task.Payload, err)
	}
	if _, err = newCancellationManager(target, nil).CancelTask(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	restored, err := target.GetInstanceBackupPolicy(ctx, fixture.instanceID)
	if err != nil || !restored.Enabled || restored.NextRunAt == nil || !restored.NextRunAt.Equal(nextRunAt) {
		t.Fatalf("canceled delete did not restore the policy: policy=%#v err=%v", restored, err)
	}
}

func TestQueuedScheduledBackupCancellationRestoresInstanceAndTracksOutcome(t *testing.T) {
	ctx, pool := openCancellationTest(t)
	fixture := seedCancellationFixture(t, ctx, pool)
	target := store.New(pool)
	scheduledAt := time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond)
	nextRunAt := scheduledAt.Add(24 * time.Hour)
	if _, err := pool.Exec(ctx, `INSERT INTO instance_backup_policies(instance_id,enabled,next_run_at,configured_by)
		VALUES($1,true,$2,$3)`, fixture.instanceID, scheduledAt, fixture.userID); err != nil {
		t.Fatal(err)
	}
	policy, err := target.GetInstanceBackupPolicy(ctx, fixture.instanceID)
	if err != nil {
		t.Fatal(err)
	}
	backupID := uuid.New()
	policyID := fixture.instanceID
	backup, task, err := target.CreateScheduledInstanceBackupTask(ctx, store.TaskInput{Kind: "instance.backup",
		ResourceType: "instance", ResourceID: &fixture.instanceID, RequestedBy: fixture.userID,
		HostID: &fixture.hostID, Payload: ActionPayload{InstanceID: fixture.instanceID, BackupID: &backupID,
			BackupPolicyID: &policyID, PreviousStatus: "running", PreviousDesiredState: "running",
			ScheduledFor: &scheduledAt}}, policy, domain.InstanceBackup{ID: backupID, InstanceID: fixture.instanceID,
		Name: "scheduled-backup", RemotePath: "/opt/dbmock/backups/" + fixture.instanceID.String() + "/" + backupID.String() + ".tar.gz"},
		"running", "running", nextRunAt, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = newCancellationManager(target, nil).CancelTask(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	instance, err := target.GetInstance(ctx, fixture.instanceID)
	if err != nil || instance.Status != "running" || instance.DesiredState != "running" || instance.StatusMessage != "" {
		t.Fatalf("scheduled backup cancellation did not restore instance: instance=%#v err=%v", instance, err)
	}
	backup, err = target.GetInstanceBackup(ctx, backup.ID)
	if err != nil || backup.Status != "failed" || backup.ErrorMessage != "Backup creation was canceled before the archive was created" {
		t.Fatalf("scheduled backup cancellation outcome = backup:%#v err:%v", backup, err)
	}
	policy, err = target.GetInstanceBackupPolicy(ctx, fixture.instanceID)
	if err != nil || policy.LastStatus != "canceled" || policy.LastTaskID == nil || *policy.LastTaskID != task.ID ||
		policy.NextRunAt == nil || !policy.NextRunAt.Equal(nextRunAt) {
		t.Fatalf("scheduled backup policy outcome = policy:%#v err:%v", policy, err)
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

func TestClaimedReconfigurationRetryCancellationRestoresAttemptStartConfiguration(t *testing.T) {
	ctx, pool := openCancellationTest(t)
	fixture := seedCancellationFixture(t, ctx, pool)
	target := store.New(pool)
	vault, err := appcrypto.NewVault(bytes.Repeat([]byte{9}, 32))
	if err != nil {
		t.Fatal(err)
	}
	currentJSON := json.RawMessage(`{"extraEnvironment":{"CURRENT":"1"}}`)
	originalJSON := json.RawMessage(`{"extraEnvironment":{"ORIGINAL":"1"}}`)
	targetJSON := json.RawMessage(`{"extraEnvironment":{"TARGET":"1"}}`)
	if _, err = pool.Exec(ctx, `UPDATE instances SET configuration=$2,auto_restart=false WHERE id=$1`, fixture.instanceID, currentJSON); err != nil {
		t.Fatal(err)
	}
	encryptedOriginal, err := vault.Seal(originalJSON, runtimeConfigurationContext(fixture.instanceID))
	if err != nil {
		t.Fatal(err)
	}
	encryptedTarget, err := vault.Seal(targetJSON, runtimeConfigurationContext(fixture.instanceID))
	if err != nil {
		t.Fatal(err)
	}
	resourceID := fixture.instanceID
	original, err := target.CreateTask(ctx, store.TaskInput{Kind: "instance.reconfigure", ResourceType: "instance",
		ResourceID: &resourceID, RequestedBy: fixture.userID, HostID: &fixture.hostID,
		Payload: ActionPayload{InstanceID: fixture.instanceID, PreviousStatus: "running", PreviousDesiredState: "running",
			PreviousCPU: 1, PreviousMemoryBytes: 1073741824, PreviousDiskBytes: 10737418240,
			TargetCPU: 2, TargetMemoryBytes: 2147483648, TargetDiskBytes: 21474836480,
			EncryptedPreviousConfig: encryptedOriginal, EncryptedTargetConfig: encryptedTarget,
			PreviousAutoRestart: boolValue(true), TargetAutoRestart: boolValue(true)}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE tasks SET status='failed',stage='failed',cancelable=false,
		error_code='task_failed',error_message='configuration failed',finished_at=now() WHERE id=$1`, original.ID); err != nil {
		t.Fatal(err)
	}
	retry, err := target.RetryTask(ctx, original.ID, fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	if err = target.RequestTaskCancel(ctx, retry.ID); err != nil {
		t.Fatal(err)
	}
	manager := tasks.New(target, slog.New(slog.NewTextHandler(io.Discard, nil)), 1)
	NewService(target, vault, nil, manager)
	workerContext, stopWorkers := context.WithCancel(ctx)
	if err = manager.Start(workerContext); err != nil {
		stopWorkers()
		t.Fatal(err)
	}
	manager.Wake()
	t.Cleanup(func() {
		stopWorkers()
		manager.Wait()
	})
	deadline := time.Now().Add(5 * time.Second)
	for {
		finished, getErr := target.GetTask(ctx, retry.ID)
		if getErr != nil {
			t.Fatal(getErr)
		}
		if finished.Status == "canceled" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("claimed retry cancellation did not finish: %#v", finished)
		}
		time.Sleep(10 * time.Millisecond)
	}
	instance, err := target.GetInstance(ctx, fixture.instanceID)
	if err != nil || instance.Status != "running" || instance.AutoRestart || !sameJSON(instance.Configuration, currentJSON) {
		t.Fatalf("retry cancellation restored stale original configuration: instance=%#v err=%v", instance, err)
	}
}
