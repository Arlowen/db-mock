package store_test

import (
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

func TestDeleteHostKeepsHistoryWithoutBlockingCleanup(t *testing.T) {
	ctx, pool := openInstanceStoreTest(t)
	userID, hostID, templateID, versionID, instanceID, backupID, taskID :=
		uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,username,password_hash) VALUES($1,'host-cleanup-user','hash')`, []any{userID}},
		{`INSERT INTO hosts(id,name,ssh_address,ssh_user,auth_type,encrypted_credential,connection_address,data_root)
            VALUES($1,'cleanup-host','127.0.0.1','tester','password','sealed','127.0.0.1','/opt/dbmock')`, []any{hostID}},
		{`INSERT INTO templates(id,slug,name,name_zh,category,tier)
            VALUES($1,'cleanup-postgres','PostgreSQL','PostgreSQL','sql','standard')`, []any{templateID}},
		{`INSERT INTO template_versions(id,template_id,version,image_reference,min_cpu,min_memory_bytes,
            min_disk_bytes,default_port,compose_template)
            VALUES($1,$2,'17','postgres:17',1,1024,2048,5432,'services: {}')`, []any{versionID, templateID}},
		{`INSERT INTO instances(id,name,host_id,template_version_id,status,desired_state,cpu,memory_bytes,
            reserved_disk_bytes,host_port,container_port,database_username,encrypted_password,
            compose_project,remote_directory)
            VALUES($1,'deleted-db',$2,$3,'deleted','deleted',1,1024,2048,25432,5432,'dbmock','sealed',
            'deleted_db','/opt/dbmock/deleted-db')`, []any{instanceID, hostID, versionID}},
		{`INSERT INTO instance_backups(id,instance_id,host_id,template_version_id,name,status,remote_path,created_by)
            VALUES($1,$2,$3,$4,'deleted-backup','ready','/opt/dbmock/deleted-db/backups/backup.tar',$5)`,
			[]any{backupID, instanceID, hostID, versionID, userID}},
		{`INSERT INTO tasks(id,kind,status,resource_type,resource_id,requested_by,host_id)
            VALUES($1,'instance.delete','succeeded','instance',$2,$3,$4)`, []any{taskID, instanceID, userID, hostID}},
	} {
		if _, err := pool.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	if err := store.New(pool).DeleteHost(ctx, hostID); err != nil {
		t.Fatalf("delete host with only historical instances: %v", err)
	}
	var hostCount, backupCount int
	var historicalHostID, taskHostID *uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM hosts WHERE id=$1`, hostID).Scan(&hostCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT host_id FROM instances WHERE id=$1`, instanceID).Scan(&historicalHostID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM instance_backups WHERE id=$1`, backupID).Scan(&backupCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT host_id FROM tasks WHERE id=$1`, taskID).Scan(&taskHostID); err != nil {
		t.Fatal(err)
	}
	if hostCount != 0 || historicalHostID != nil || backupCount != 0 || taskHostID != nil {
		t.Fatalf("cleanup left host=%d instanceHost=%v backups=%d taskHost=%v",
			hostCount, historicalHostID, backupCount, taskHostID)
	}
}

func TestDeleteHostStillRejectsActiveInstances(t *testing.T) {
	ctx, pool := openInstanceStoreTest(t)
	hostID, templateID, versionID, instanceID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO hosts(id,name,ssh_address,ssh_user,auth_type,encrypted_credential,connection_address,data_root)
            VALUES($1,'active-host','127.0.0.1','tester','password','sealed','127.0.0.1','/opt/dbmock')`, []any{hostID}},
		{`INSERT INTO templates(id,slug,name,name_zh,category,tier)
            VALUES($1,'active-postgres','PostgreSQL','PostgreSQL','sql','standard')`, []any{templateID}},
		{`INSERT INTO template_versions(id,template_id,version,image_reference,min_cpu,min_memory_bytes,
            min_disk_bytes,default_port,compose_template)
            VALUES($1,$2,'17','postgres:17',1,1024,2048,5432,'services: {}')`, []any{versionID, templateID}},
		{`INSERT INTO instances(id,name,host_id,template_version_id,status,cpu,memory_bytes,reserved_disk_bytes,
            host_port,container_port,database_username,encrypted_password,compose_project,remote_directory)
            VALUES($1,'active-db',$2,$3,'running',1,1024,2048,25432,5432,'dbmock','sealed',
            'active_db','/opt/dbmock/active-db')`, []any{instanceID, hostID, versionID}},
	} {
		if _, err := pool.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	if err := store.New(pool).DeleteHost(ctx, hostID); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("delete host with active instance error = %v, want conflict", err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM hosts WHERE id=$1`, hostID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("active host count = %d, err = %v", count, err)
	}
}
