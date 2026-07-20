package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

type Handler func(context.Context, *Runtime, domain.Task) (any, error)

type Manager struct {
	store    *store.Store
	logger   *slog.Logger
	workers  int
	handlers map[string]Handler
	wake     chan struct{}
	wg       sync.WaitGroup
}

type Runtime struct {
	store  *store.Store
	taskID domain.Task
}

func New(target *store.Store, logger *slog.Logger, workers int) *Manager {
	return &Manager{store: target, logger: logger, workers: workers, handlers: make(map[string]Handler), wake: make(chan struct{}, 1)}
}

func (m *Manager) Register(kind string, handler Handler) { m.handlers[kind] = handler }

func (m *Manager) Start(ctx context.Context) error {
	if err := m.store.InterruptRunningTasks(ctx); err != nil {
		return err
	}
	for i := 0; i < m.workers; i++ {
		m.wg.Add(1)
		go m.worker(ctx, i)
	}
	return nil
}

func (m *Manager) Wait() { m.wg.Wait() }
func (m *Manager) Wake() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

func (m *Manager) worker(ctx context.Context, index int) {
	defer m.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		task, err := m.store.ClaimTask(ctx)
		if err != nil {
			if !errors.Is(err, domain.ErrNotFound) {
				m.logger.Error("claim task", "worker", index, "error", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-m.wake:
			case <-time.After(time.Second):
			}
			continue
		}
		m.run(ctx, task)
	}
}

func (m *Manager) run(parent context.Context, task domain.Task) {
	handler, ok := m.handlers[task.Kind]
	if !ok {
		_ = m.store.FinishTask(parent, task.ID, "failed", nil, "unknown_task_kind", "No task handler is registered")
		m.enqueueWebhook(parent, task, "failed")
		return
	}
	runtime := &Runtime{store: m.store, taskID: task}
	_ = runtime.Log(parent, "info", "Task started")
	result, err := handler(parent, runtime, task)
	if err != nil {
		status := "failed"
		code := "task_failed"
		if errors.Is(err, context.Canceled) || errors.Is(err, ErrCanceled) {
			status = "canceled"
			code = "canceled"
		}
		_ = runtime.Log(parent, "error", redact(err.Error()))
		_ = m.store.FinishTask(parent, task.ID, status, nil, code, redact(err.Error()))
		m.enqueueWebhook(parent, task, status)
		m.logger.Warn("task failed", "taskId", task.ID, "kind", task.Kind, "error", redact(err.Error()))
		return
	}
	_ = runtime.Log(parent, "info", "Task completed")
	_ = m.store.FinishTask(parent, task.ID, "succeeded", result, "", "")
	m.enqueueWebhook(parent, task, "succeeded")
	m.Wake()
}

func (m *Manager) enqueueWebhook(ctx context.Context, original domain.Task, status string) {
	task, err := m.store.GetTask(ctx, original.ID)
	if err != nil {
		return
	}
	_ = m.store.EnqueueWebhookEvent(ctx, "task.finished", task)
	_ = m.store.EnqueueWebhookEvent(ctx, "task."+status, task)
}

var ErrCanceled = errors.New("task canceled")

func (r *Runtime) Stage(ctx context.Context, progress int, stage, message string, cancelable bool) error {
	task, err := r.store.GetTask(ctx, r.taskID.ID)
	if err != nil {
		return err
	}
	if task.CancelAsked && cancelable {
		return ErrCanceled
	}
	if err := r.store.UpdateTask(ctx, r.taskID.ID, progress, stage, message, cancelable); err != nil {
		return err
	}
	return r.Log(ctx, "info", message)
}
func (r *Runtime) Log(ctx context.Context, level, message string) error {
	return r.store.AddTaskLog(ctx, r.taskID.ID, level, redact(message))
}
func (r *Runtime) Store() *store.Store { return r.store }

func redact(value string) string {
	patterns := []string{"password=", "password: ", "token=", "secret=", "private key"}
	lower := strings.ToLower(value)
	for _, pattern := range patterns {
		if index := strings.Index(lower, pattern); index >= 0 {
			return value[:index] + pattern + "[REDACTED]"
		}
	}
	if len(value) > 8000 {
		return value[:8000] + "…"
	}
	return value
}

func DecodePayload(task domain.Task, target any) error {
	if err := jsonUnmarshal(task.Payload, target); err != nil {
		return fmt.Errorf("decode task payload: %w", err)
	}
	return nil
}

var jsonUnmarshal = func(data []byte, target any) error {
	return json.Unmarshal(data, target)
}
