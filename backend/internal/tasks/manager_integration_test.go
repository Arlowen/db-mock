package tasks

import (
	"context"
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
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

func openManagerTest(t *testing.T) (context.Context, *pgxpool.Pool) {
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
	schema := "task_manager_" + strings.ReplaceAll(uuid.NewString(), "-", "")
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

func TestRunPersistsAnInterruptedTaskAfterApplicationContextCancellation(t *testing.T) {
	ctx, pool := openManagerTest(t)
	userID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,username,password_hash) VALUES($1,'shutdown-worker','hash')`, userID); err != nil {
		t.Fatal(err)
	}
	target := store.New(pool)
	queued, err := target.CreateTask(ctx, store.TaskInput{Kind: "shutdown.test", ResourceType: "test",
		RequestedBy: userID, Payload: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := target.ClaimTask(ctx)
	if err != nil || claimed.ID != queued.ID {
		t.Fatalf("claimed task = %#v, err=%v", claimed, err)
	}

	manager := New(target, slog.New(slog.NewTextHandler(io.Discard, nil)), 1)
	started := make(chan struct{})
	manager.Register("shutdown.test", func(handlerContext context.Context, _ *Runtime, _ domain.Task) (any, error) {
		close(started)
		<-handlerContext.Done()
		return nil, handlerContext.Err()
	})
	parent, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		manager.run(parent, claimed)
		close(done)
	}()
	<-started
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("task finalization did not finish")
	}

	finished, err := target.GetTask(ctx, claimed.ID)
	if err != nil {
		t.Fatal(err)
	}
	if finished.Status != "interrupted" || finished.ErrorCode != "application_stopped" ||
		finished.FinishedAt == nil || finished.Cancelable {
		t.Fatalf("task after graceful shutdown = %#v", finished)
	}
}

func TestRunPreservesExplicitTaskCancellation(t *testing.T) {
	ctx, pool := openManagerTest(t)
	userID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,username,password_hash) VALUES($1,'cancel-worker','hash')`, userID); err != nil {
		t.Fatal(err)
	}
	target := store.New(pool)
	queued, err := target.CreateTask(ctx, store.TaskInput{Kind: "cancel.test", ResourceType: "test",
		RequestedBy: userID, Payload: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := target.ClaimTask(ctx)
	if err != nil || claimed.ID != queued.ID {
		t.Fatalf("claimed task = %#v, err=%v", claimed, err)
	}

	manager := New(target, slog.New(slog.NewTextHandler(io.Discard, nil)), 1)
	manager.Register("cancel.test", func(context.Context, *Runtime, domain.Task) (any, error) {
		return nil, ErrCanceled
	})
	manager.run(ctx, claimed)

	finished, err := target.GetTask(ctx, claimed.ID)
	if err != nil {
		t.Fatal(err)
	}
	if finished.Status != "canceled" || finished.ErrorCode != "canceled" ||
		finished.FinishedAt == nil || finished.Cancelable {
		t.Fatalf("explicitly canceled task = %#v", finished)
	}
}
