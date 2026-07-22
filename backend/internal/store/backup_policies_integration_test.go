package store_test

import (
	"context"
	"errors"
	"fmt"
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

func TestScheduledBackupQueueIsAtomic(t *testing.T) {
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
	schema := "backup_policy_" + strings.ReplaceAll(uuid.NewString(), "-", "")
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

	userID, schedulerUserID, hostID, templateID, versionID, instanceID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	seed := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,username,password_hash) VALUES($1,'scheduler-test','hash')`, []any{userID}},
		{`INSERT INTO users(id,username,password_hash) VALUES($1,'scheduler-current','hash')`, []any{schedulerUserID}},
		{`INSERT INTO hosts(id,name,ssh_address,ssh_user,auth_type,encrypted_credential,connection_address,
            data_root,status) VALUES($1,'host','127.0.0.1','tester','password','sealed','127.0.0.1','/opt/dbmock','online')`, []any{hostID}},
		{`INSERT INTO templates(id,slug,name,name_zh,category,tier) VALUES($1,'postgres-test','PostgreSQL','PostgreSQL','sql','standard')`, []any{templateID}},
		{`INSERT INTO template_versions(id,template_id,version,image_reference,min_cpu,min_memory_bytes,
            min_disk_bytes,default_port,compose_template) VALUES($1,$2,'17','postgres:17',1,1024,2048,5432,'services: {}')`, []any{versionID, templateID}},
		{`INSERT INTO instances(id,name,host_id,template_version_id,status,cpu,memory_bytes,reserved_disk_bytes,
            host_port,container_port,database_username,encrypted_password,compose_project,remote_directory)
            VALUES($1,'scheduled-db',$2,$3,'running',1,1024,2048,25432,5432,'postgres','sealed',$4,$5)`,
			[]any{instanceID, hostID, versionID, "dbmock_" + strings.ReplaceAll(instanceID.String(), "-", ""), "/opt/dbmock/instances/" + instanceID.String()}},
	}
	for _, statement := range seed {
		if _, err = pool.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	target := store.New(pool)
	now := time.Date(2026, 7, 22, 2, 0, 0, 0, time.UTC)
	due := now.Add(-time.Minute)
	policy, err := target.UpsertInstanceBackupPolicy(ctx, store.InstanceBackupPolicyInput{InstanceID: instanceID,
		Enabled: true, Frequency: "daily", Hour: 2, Timezone: "UTC", RetentionCount: 3,
		NextRunAt: &due, ConfiguredBy: userID})
	if err != nil {
		t.Fatal(err)
	}
	stalePolicy := policy
	proposed := now.Add(48 * time.Hour)
	policy, err = target.UpsertInstanceBackupPolicy(ctx, store.InstanceBackupPolicyInput{InstanceID: instanceID,
		Enabled: true, Frequency: "daily", Hour: 2, Timezone: "UTC", RetentionCount: 9,
		NextRunAt: &proposed, ConfiguredBy: schedulerUserID})
	if err != nil {
		t.Fatal(err)
	}
	if policy.NextRunAt == nil || !policy.NextRunAt.Equal(due) || policy.RetentionCount != 9 {
		t.Fatalf("retention-only update must preserve the due run: %#v", policy)
	}
	duePolicies, err := target.ListDueInstanceBackupPolicies(ctx, now, 10)
	if err != nil || len(duePolicies) != 1 || duePolicies[0].InstanceID != instanceID {
		t.Fatalf("due policies = %#v, err = %v", duePolicies, err)
	}
	backupID := uuid.New()
	resourceID := instanceID
	next := now.Add(24 * time.Hour)
	if _, err = pool.Exec(ctx, `UPDATE instances SET desired_state='stopped' WHERE id=$1`, instanceID); err != nil {
		t.Fatal(err)
	}
	_, _, err = target.CreateScheduledInstanceBackupTask(ctx, store.TaskInput{Kind: "instance.backup",
		ResourceType: "instance", ResourceID: &resourceID, RequestedBy: userID, HostID: &hostID,
		Payload: map[string]any{"instanceId": instanceID, "backupId": backupID}}, stalePolicy,
		domain.InstanceBackup{ID: backupID, InstanceID: instanceID, Name: "stale state",
			RemotePath: fmt.Sprintf("/opt/dbmock/backups/%s/%s.tar.gz", instanceID, backupID), CreatedBy: userID},
		"running", "running", next, now)
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("a changed desired state must abort the queue transaction, got %v", err)
	}
	if _, err = pool.Exec(ctx, `UPDATE instances SET desired_state='running' WHERE id=$1`, instanceID); err != nil {
		t.Fatal(err)
	}
	backup, task, err := target.CreateScheduledInstanceBackupTask(ctx, store.TaskInput{Kind: "instance.backup",
		ResourceType: "instance", ResourceID: &resourceID, RequestedBy: userID, HostID: &hostID,
		Payload: map[string]any{"instanceId": instanceID, "backupId": backupID}}, stalePolicy,
		domain.InstanceBackup{ID: backupID, InstanceID: instanceID, Name: "Scheduled test",
			RemotePath: fmt.Sprintf("/opt/dbmock/backups/%s/%s.tar.gz", instanceID, backupID), CreatedBy: userID},
		"running", "running", next, now)
	if err != nil {
		t.Fatal(err)
	}
	if backup.CreationType != "scheduled" || backup.Status != "creating" || task.Status != "queued" ||
		backup.CreatedBy != schedulerUserID || task.RequestedBy != schedulerUserID {
		t.Fatalf("unexpected queued backup/task: %#v %#v", backup, task)
	}
	instance, err := target.GetInstance(ctx, instanceID)
	if err != nil || instance.Status != "backing_up" {
		t.Fatalf("instance status = %q, err = %v", instance.Status, err)
	}
	storedPolicy, err := target.GetInstanceBackupPolicy(ctx, instanceID)
	if err != nil || storedPolicy.LastTaskID == nil || *storedPolicy.LastTaskID != task.ID ||
		storedPolicy.LastStatus != "queued" || storedPolicy.NextRunAt == nil || !storedPolicy.NextRunAt.Equal(next) {
		t.Fatalf("unexpected stored policy: %#v, err = %v", storedPolicy, err)
	}
	if _, _, err = target.CreateScheduledInstanceBackupTask(ctx, store.TaskInput{Kind: "instance.backup",
		ResourceType: "instance", ResourceID: &resourceID, RequestedBy: userID, HostID: &hostID,
		Payload: map[string]any{"instanceId": instanceID}}, policy, domain.InstanceBackup{ID: uuid.New(),
		InstanceID: instanceID, Name: "duplicate", RemotePath: "/opt/dbmock/backups/duplicate.tar.gz",
		CreatedBy: userID}, "running", "running", next, now); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("stale schedule should conflict, got %v", err)
	}
	var backupCount, taskCount int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM instance_backups`).Scan(&backupCount); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM tasks`).Scan(&taskCount); err != nil {
		t.Fatal(err)
	}
	if backupCount != 1 || taskCount != 1 {
		t.Fatalf("stale queue attempt leaked rows: backups=%d tasks=%d", backupCount, taskCount)
	}
	if _, err = pool.Exec(ctx, `UPDATE tasks SET status='running' WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	if err = target.TrackInstanceBackupPolicyTask(ctx, instanceID, task.ID); err != nil {
		t.Fatal(err)
	}
	if err = target.InterruptRunningTasks(ctx); err != nil {
		t.Fatal(err)
	}
	storedPolicy, err = target.GetInstanceBackupPolicy(ctx, instanceID)
	if err != nil || storedPolicy.LastStatus != "failed" || !strings.Contains(storedPolicy.LastError, "restarted") {
		t.Fatalf("interrupted task was not reflected in the backup policy: %#v, err=%v", storedPolicy, err)
	}
}
