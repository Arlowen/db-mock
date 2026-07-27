package store_test

import (
	"testing"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/store"
)

func TestDashboardAttentionOnlyKeepsUnresolvedFailuresAndCurrentExceptions(t *testing.T) {
	ctx, pool := openInstanceStoreTest(t)
	userID, hostID, templateID, versionID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	activeInstanceID, degradedInstanceID, deletedInstanceID := uuid.New(), uuid.New(), uuid.New()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users(id,username,password_hash) VALUES($1,'dashboard-user','hash')`, []any{userID}},
		{`INSERT INTO hosts(id,name,ssh_address,ssh_user,auth_type,encrypted_credential,connection_address,
            data_root,status,cpu_count,memory_bytes,disk_free_bytes,port_start,port_end)
            VALUES($1,'attention-host','127.0.0.1','tester','password','sealed','127.0.0.1','/opt/dbmock',
            'online',8,17179869184,107374182400,25000,25010)`, []any{hostID}},
		{`INSERT INTO templates(id,slug,name,name_zh,category,tier)
            VALUES($1,'attention-postgres','PostgreSQL','PostgreSQL','sql','standard')`, []any{templateID}},
		{`INSERT INTO template_versions(id,template_id,version,image_reference,min_cpu,min_memory_bytes,
            min_disk_bytes,default_port,compose_template) VALUES($1,$2,'17','postgres:17',1,1073741824,
            10737418240,5432,'services: {}')`, []any{versionID, templateID}},
		{`INSERT INTO instances(id,name,host_id,template_version_id,status,desired_state,cpu,memory_bytes,
            reserved_disk_bytes,host_port,container_port,database_username,encrypted_password,database_name,
            compose_project,remote_directory)
            VALUES($1,'unresolved-db',$2,$3,'failed','running',1,1073741824,10737418240,25000,5432,
            'dbmock','sealed','app',$4,$5)`, []any{activeInstanceID, hostID, versionID, "dbmock_" + activeInstanceID.String(), "/opt/dbmock/" + activeInstanceID.String()}},
		{`INSERT INTO instances(id,name,host_id,template_version_id,status,desired_state,cpu,memory_bytes,
            reserved_disk_bytes,host_port,container_port,database_username,encrypted_password,database_name,
            compose_project,remote_directory)
            VALUES($1,'degraded-db',$2,$3,'degraded','running',1,1073741824,10737418240,25001,5432,
            'dbmock','sealed','app',$4,$5)`, []any{degradedInstanceID, hostID, versionID, "dbmock_" + degradedInstanceID.String(), "/opt/dbmock/" + degradedInstanceID.String()}},
		{`INSERT INTO instances(id,name,host_id,template_version_id,status,desired_state,cpu,memory_bytes,
            reserved_disk_bytes,host_port,container_port,database_username,encrypted_password,database_name,
            compose_project,remote_directory)
            VALUES($1,'deleted-db',$2,$3,'deleted','deleted',1,1073741824,10737418240,25002,5432,
            'dbmock','sealed','app',$4,$5)`, []any{deletedInstanceID, hostID, versionID, "dbmock_" + deletedInstanceID.String(), "/opt/dbmock/" + deletedInstanceID.String()}},
	} {
		if _, err := pool.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	target := store.New(pool)
	failed, err := target.CreateTask(ctx, store.TaskInput{
		Kind: "instance.create", ResourceType: "instance", ResourceID: &activeInstanceID,
		RequestedBy: userID, HostID: &hostID, Payload: map[string]any{"instanceId": activeInstanceID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = target.FinishTask(ctx, failed.ID, "failed", nil, "ssh_unreachable", "dial SSH"); err != nil {
		t.Fatal(err)
	}
	deletedFailure, err := target.CreateTask(ctx, store.TaskInput{
		Kind: "instance.delete", ResourceType: "instance", ResourceID: &deletedInstanceID,
		RequestedBy: userID, HostID: &hostID, Payload: map[string]any{"instanceId": deletedInstanceID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = target.FinishTask(ctx, deletedFailure.ID, "failed", nil, "task_failed", "delete failed"); err != nil {
		t.Fatal(err)
	}

	dashboard, err := target.Dashboard(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(dashboard.AttentionItems) != 2 {
		t.Fatalf("attention items = %#v", dashboard.AttentionItems)
	}
	if dashboard.AttentionItems[0].ResourceID != activeInstanceID ||
		dashboard.AttentionItems[0].TaskID == nil || *dashboard.AttentionItems[0].TaskID != failed.ID ||
		dashboard.AttentionItems[0].ErrorCode != "ssh_unreachable" {
		t.Fatalf("first attention item = %#v", dashboard.AttentionItems[0])
	}
	if dashboard.AttentionItems[1].ResourceID != degradedInstanceID ||
		dashboard.AttentionItems[1].TaskID != nil || dashboard.AttentionItems[1].ResourceStatus != "degraded" {
		t.Fatalf("second attention item = %#v", dashboard.AttentionItems[1])
	}

	retry, err := target.CreateTask(ctx, store.TaskInput{
		Kind: "instance.create", ResourceType: "instance", ResourceID: &activeInstanceID,
		RequestedBy: userID, HostID: &hostID, Payload: map[string]any{"instanceId": activeInstanceID},
	})
	if err != nil {
		t.Fatal(err)
	}
	dashboard, err = target.Dashboard(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(dashboard.AttentionItems) != 2 {
		t.Fatalf("queued retry should suppress only the old task failure, got %#v", dashboard.AttentionItems)
	}
	for _, item := range dashboard.AttentionItems {
		if item.TaskID != nil && *item.TaskID == failed.ID {
			t.Fatalf("old failure remained after retry %s was queued: %#v", retry.ID, dashboard.AttentionItems)
		}
	}
}
