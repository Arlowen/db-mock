package store_test

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/store"
)

func TestListTemplatesIncludesHistoricalDeploymentUsage(t *testing.T) {
	ctx, pool := openInstanceStoreTest(t)
	hostID, postgresTemplateID, postgresVersionID := uuid.New(), uuid.New(), uuid.New()
	redisTemplateID, redisVersionID := uuid.New(), uuid.New()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO hosts(id,name,ssh_address,ssh_user,auth_type,encrypted_credential,connection_address,
            data_root,status,cpu_count,memory_bytes,disk_free_bytes,port_start,port_end)
            VALUES($1,'usage-host','127.0.0.1','tester','password','sealed','127.0.0.1','/opt/dbmock',
            'online',8,17179869184,107374182400,25000,25010)`, []any{hostID}},
		{`INSERT INTO templates(id,slug,name,name_zh,category,tier)
            VALUES($1,'usage-postgres','PostgreSQL','PostgreSQL','sql','standard')`, []any{postgresTemplateID}},
		{`INSERT INTO template_versions(id,template_id,version,image_reference,min_cpu,min_memory_bytes,
            min_disk_bytes,default_port,compose_template) VALUES($1,$2,'17','postgres:17',1,1073741824,
            10737418240,5432,'services: {}')`, []any{postgresVersionID, postgresTemplateID}},
		{`INSERT INTO templates(id,slug,name,name_zh,category,tier)
            VALUES($1,'usage-redis','Redis','Redis','key-value','standard')`, []any{redisTemplateID}},
		{`INSERT INTO template_versions(id,template_id,version,image_reference,min_cpu,min_memory_bytes,
            min_disk_bytes,default_port,compose_template) VALUES($1,$2,'8','redis:8',0.5,536870912,
            2147483648,6379,'services: {}')`, []any{redisVersionID, redisTemplateID}},
	} {
		if _, err := pool.Exec(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	older := time.Now().UTC().Add(-72 * time.Hour).Truncate(time.Second)
	recentDeleted := time.Now().UTC().Add(-6 * time.Hour).Truncate(time.Second)
	redisUsed := time.Now().UTC().Add(-24 * time.Hour).Truncate(time.Second)
	for _, item := range []struct {
		id        uuid.UUID
		name      string
		versionID uuid.UUID
		status    string
		desired   string
		port      int
		createdAt time.Time
	}{
		{uuid.New(), "active-postgres", postgresVersionID, "running", "running", 25000, older},
		{uuid.New(), "deleted-postgres", postgresVersionID, "deleted", "deleted", 25001, recentDeleted},
		{uuid.New(), "active-redis", redisVersionID, "stopped", "stopped", 25002, redisUsed},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO instances(id,name,host_id,template_version_id,status,desired_state,
            cpu,memory_bytes,reserved_disk_bytes,host_port,container_port,database_username,encrypted_password,
            compose_project,remote_directory,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,1,1073741824,10737418240,$7,5432,'dbmock','sealed',$8,$9,$10,$10)`,
			item.id, item.name, hostID, item.versionID, item.status, item.desired, item.port,
			"dbmock_"+item.id.String(), "/opt/dbmock/instances/"+item.id.String(), item.createdAt); err != nil {
			t.Fatal(err)
		}
	}

	items, err := store.New(pool).ListTemplates(ctx)
	if err != nil {
		t.Fatal(err)
	}
	usage := make(map[uuid.UUID]struct {
		count int
		last  *time.Time
	})
	for _, template := range items {
		for _, version := range template.Versions {
			usage[version.ID] = struct {
				count int
				last  *time.Time
			}{version.DeploymentCount, version.LastDeployedAt}
		}
	}
	if usage[postgresVersionID].count != 2 || usage[postgresVersionID].last == nil ||
		!usage[postgresVersionID].last.Equal(recentDeleted) {
		t.Fatalf("PostgreSQL usage = %#v", usage[postgresVersionID])
	}
	if usage[redisVersionID].count != 1 || usage[redisVersionID].last == nil ||
		!usage[redisVersionID].last.Equal(redisUsed) {
		t.Fatalf("Redis usage = %#v", usage[redisVersionID])
	}
}
