package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

const claimBarrierKey int64 = 4829471

func TestClaimTaskSerializesConcurrentWorkOnTheSameHost(t *testing.T) {
	ctx, pool := openInstanceStoreTest(t)
	userID, hostID := uuid.New(), uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,username,password_hash) VALUES($1,'task-worker','hash')`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO hosts(id,name,ssh_address,ssh_user,auth_type,encrypted_credential,
		connection_address,data_root,status) VALUES($1,'task-host','127.0.0.1','tester','password','sealed',
		'127.0.0.1','/opt/dbmock','online')`, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		CREATE FUNCTION hold_task_claim_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF OLD.status = 'queued' AND NEW.status = 'running' THEN
				PERFORM pg_advisory_xact_lock(4829471);
			END IF;
			RETURN NEW;
		END $$;
		CREATE TRIGGER hold_task_claim_for_test
			BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION hold_task_claim_for_test()`); err != nil {
		t.Fatal(err)
	}

	target := store.New(pool)
	for range 2 {
		if _, err := target.CreateTask(ctx, store.TaskInput{Kind: "host.test", ResourceType: "test",
			RequestedBy: userID, HostID: &hostID, Payload: map[string]any{}}); err != nil {
			t.Fatal(err)
		}
	}

	barrier, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer barrier.Release()
	if _, err = barrier.Exec(ctx, "SELECT pg_advisory_lock($1)", claimBarrierKey); err != nil {
		t.Fatal(err)
	}
	barrierHeld := true
	defer func() {
		if barrierHeld {
			_, _ = barrier.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", claimBarrierKey)
		}
	}()

	type claimResult struct {
		task domain.Task
		err  error
	}
	results := make(chan claimResult, 2)
	start := make(chan struct{})
	ready := make(chan struct{}, 2)
	for range 2 {
		go func() {
			ready <- struct{}{}
			<-start
			task, claimErr := target.ClaimTask(ctx)
			results <- claimResult{task: task, err: claimErr}
		}()
	}
	<-ready
	<-ready
	close(start)

	if !waitForAdvisoryWaiters(t, ctx, pool, 1, 3*time.Second) {
		t.Fatal("no task claim reached the test barrier")
	}
	// Give a second claim enough time to pass the running-task check. Without a
	// host lock both transactions reach this barrier before either can commit.
	waitForAdvisoryWaiters(t, ctx, pool, 2, 500*time.Millisecond)
	if _, err = barrier.Exec(ctx, "SELECT pg_advisory_unlock($1)", claimBarrierKey); err != nil {
		t.Fatal(err)
	}
	barrierHeld = false

	succeeded, unavailable := 0, 0
	for range 2 {
		select {
		case result := <-results:
			if result.err == nil {
				succeeded++
				if result.task.Status != "running" || result.task.HostID == nil || *result.task.HostID != hostID {
					t.Fatalf("claimed task = %#v", result.task)
				}
			} else if errors.Is(result.err, domain.ErrNotFound) {
				unavailable++
			} else {
				t.Fatalf("unexpected claim error: %v", result.err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("concurrent task claims did not finish")
		}
	}
	if succeeded != 1 || unavailable != 1 {
		t.Fatalf("same-host claims: succeeded=%d unavailable=%d, want one of each", succeeded, unavailable)
	}
}

func TestClaimTaskSkipsAHostThatAlreadyHasRunningWork(t *testing.T) {
	ctx, pool := openInstanceStoreTest(t)
	userID, busyHostID, idleHostID := uuid.New(), uuid.New(), uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,username,password_hash) VALUES($1,'task-scheduler','hash')`, userID); err != nil {
		t.Fatal(err)
	}
	for id, name := range map[uuid.UUID]string{busyHostID: "busy-host", idleHostID: "idle-host"} {
		if _, err := pool.Exec(ctx, `INSERT INTO hosts(id,name,ssh_address,ssh_user,auth_type,encrypted_credential,
			connection_address,data_root,status) VALUES($1,$2,'127.0.0.1','tester','password','sealed',
			'127.0.0.1','/opt/dbmock','online')`, id, name); err != nil {
			t.Fatal(err)
		}
	}

	target := store.New(pool)
	running, err := target.CreateTask(ctx, store.TaskInput{Kind: "host.running", ResourceType: "test",
		RequestedBy: userID, HostID: &busyHostID, Payload: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE tasks SET status='running' WHERE id=$1`, running.ID); err != nil {
		t.Fatal(err)
	}
	busyQueued, err := target.CreateTask(ctx, store.TaskInput{Kind: "host.busy", ResourceType: "test",
		RequestedBy: userID, HostID: &busyHostID, Payload: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	idleQueued, err := target.CreateTask(ctx, store.TaskInput{Kind: "host.idle", ResourceType: "test",
		RequestedBy: userID, HostID: &idleHostID, Payload: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE tasks SET created_at=CASE id WHEN $1 THEN now()-interval '2 minutes'
		WHEN $2 THEN now()-interval '1 minute' ELSE created_at END WHERE id IN ($1,$2)`, busyQueued.ID, idleQueued.ID); err != nil {
		t.Fatal(err)
	}

	claimed, err := target.ClaimTask(ctx)
	if err != nil {
		t.Fatalf("idle host task was not claimable: %v", err)
	}
	if claimed.ID != idleQueued.ID || claimed.HostID == nil || *claimed.HostID != idleHostID {
		t.Fatalf("claimed task = %#v, want idle-host task %s", claimed, idleQueued.ID)
	}
}

func waitForAdvisoryWaiters(t *testing.T, ctx context.Context, pool *pgxpool.Pool, wanted int, timeout time.Duration) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=0
			AND objid::bigint=$1 AND objsubid=1 AND NOT granted`, claimBarrierKey).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count >= wanted {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
}
