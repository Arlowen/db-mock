package tasks

import (
	"context"
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

func TestStageHonorsCancellationBeforeTheFirstNonCancelableStage(t *testing.T) {
	ctx, pool := openManagerTest(t)
	userID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,username,password_hash) VALUES($1,'queued-cancel-worker','hash')`, userID); err != nil {
		t.Fatal(err)
	}
	target := store.New(pool)
	queued, err := target.CreateTask(ctx, store.TaskInput{Kind: "queued.cancel.test", ResourceType: "test",
		RequestedBy: userID, Payload: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	if err = target.RequestTaskCancel(ctx, queued.ID); err != nil {
		t.Fatal(err)
	}
	claimed, err := target.ClaimTask(ctx)
	if err != nil || claimed.ID != queued.ID {
		t.Fatalf("claimed task = %#v, err=%v", claimed, err)
	}

	runtime := &Runtime{store: target, taskID: claimed}
	if err = runtime.Stage(ctx, 20, "compose", "Starting destructive work", false); !errors.Is(err, ErrCanceled) {
		t.Fatalf("first non-cancelable stage error = %v, want %v", err, ErrCanceled)
	}
	stored, err := target.GetTask(ctx, claimed.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Stage != "starting" || stored.Progress != 1 || !stored.CancelAsked {
		t.Fatalf("canceled task advanced past its first safe checkpoint: %#v", stored)
	}
}

func TestStageRejectsCancellationAfterEnteringANonCancelableStage(t *testing.T) {
	ctx, pool := openManagerTest(t)
	userID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,username,password_hash) VALUES($1,'late-cancel-worker','hash')`, userID); err != nil {
		t.Fatal(err)
	}
	target := store.New(pool)
	queued, err := target.CreateTask(ctx, store.TaskInput{Kind: "late.cancel.test", ResourceType: "test",
		RequestedBy: userID, Payload: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := target.ClaimTask(ctx)
	if err != nil || claimed.ID != queued.ID {
		t.Fatalf("claimed task = %#v, err=%v", claimed, err)
	}
	runtime := &Runtime{store: target, taskID: claimed}
	if err = runtime.Stage(ctx, 10, "prepare", "Preparing work", true); err != nil {
		t.Fatal(err)
	}
	if err = runtime.Stage(ctx, 50, "compose", "Applying irreversible work", false); err != nil {
		t.Fatal(err)
	}
	if err = target.RequestTaskCancel(ctx, claimed.ID); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("cancellation after a non-cancelable stage = %v, want %v", err, domain.ErrConflict)
	}
	stored, err := target.GetTask(ctx, claimed.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Stage != "compose" || stored.Progress != 50 || stored.Cancelable || stored.CancelAsked {
		t.Fatalf("non-cancelable stage was not persisted: %#v", stored)
	}
}

func TestRunStopsAQueuedCancellationBeforeNonCancelableWork(t *testing.T) {
	ctx, pool := openManagerTest(t)
	userID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,username,password_hash) VALUES($1,'queued-handler-worker','hash')`, userID); err != nil {
		t.Fatal(err)
	}
	target := store.New(pool)
	queued, err := target.CreateTask(ctx, store.TaskInput{Kind: "queued.handler.test", ResourceType: "test",
		RequestedBy: userID, Payload: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	if err = target.RequestTaskCancel(ctx, queued.ID); err != nil {
		t.Fatal(err)
	}
	claimed, err := target.ClaimTask(ctx)
	if err != nil || claimed.ID != queued.ID {
		t.Fatalf("claimed task = %#v, err=%v", claimed, err)
	}

	manager := New(target, slog.New(slog.NewTextHandler(io.Discard, nil)), 1)
	workStarted := false
	manager.Register("queued.handler.test", func(handlerContext context.Context, runtime *Runtime, _ domain.Task) (any, error) {
		if stageErr := runtime.Stage(handlerContext, 10, "compose", "Applying non-cancelable work", false); stageErr != nil {
			return nil, stageErr
		}
		workStarted = true
		return nil, nil
	})
	manager.run(ctx, claimed)
	if workStarted {
		t.Fatal("non-cancelable work started after the task was canceled in the queue")
	}
	finished, err := target.GetTask(ctx, claimed.ID)
	if err != nil {
		t.Fatal(err)
	}
	if finished.Status != "canceled" || finished.ErrorCode != "canceled" || finished.FinishedAt == nil {
		t.Fatalf("queued cancellation result = %#v", finished)
	}
}

func TestStageAndCancellationAtomicallyChooseOneWinner(t *testing.T) {
	ctx, pool := openManagerTest(t)
	userID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,username,password_hash) VALUES($1,'cancel-race-worker','hash')`, userID); err != nil {
		t.Fatal(err)
	}
	target := store.New(pool)
	for iteration := range 40 {
		queued, err := target.CreateTask(ctx, store.TaskInput{Kind: "cancel.race.test", ResourceType: "test",
			RequestedBy: userID, Payload: map[string]any{"iteration": iteration}})
		if err != nil {
			t.Fatal(err)
		}
		claimed, err := target.ClaimTask(ctx)
		if err != nil || claimed.ID != queued.ID {
			t.Fatalf("iteration %d claimed task = %#v, err=%v", iteration, claimed, err)
		}
		runtime := &Runtime{store: target, taskID: claimed}
		if err = runtime.Stage(ctx, 10, "prepare", "Preparing work", true); err != nil {
			t.Fatal(err)
		}

		start := make(chan struct{})
		stageResult, cancelResult := make(chan error, 1), make(chan error, 1)
		go func() {
			<-start
			stageResult <- runtime.Stage(ctx, 50, "compose", "Applying irreversible work", false)
		}()
		go func() {
			<-start
			cancelResult <- target.RequestTaskCancel(ctx, claimed.ID)
		}()
		close(start)
		stageErr, cancelErr := <-stageResult, <-cancelResult
		stored, getErr := target.GetTask(ctx, claimed.ID)
		if getErr != nil {
			t.Fatal(getErr)
		}
		switch {
		case stageErr == nil && errors.Is(cancelErr, domain.ErrConflict):
			if stored.Stage != "compose" || stored.Cancelable || stored.CancelAsked {
				t.Fatalf("iteration %d stage won with invalid task: %#v", iteration, stored)
			}
		case errors.Is(stageErr, ErrCanceled) && cancelErr == nil:
			if stored.Stage != "prepare" || !stored.Cancelable || !stored.CancelAsked {
				t.Fatalf("iteration %d cancellation won with invalid task: %#v", iteration, stored)
			}
		default:
			t.Fatalf("iteration %d produced stage error %v and cancellation error %v", iteration, stageErr, cancelErr)
		}
		if err = target.FinishTask(ctx, claimed.ID, "canceled", nil, "canceled", "task canceled"); err != nil {
			t.Fatal(err)
		}
	}
}
