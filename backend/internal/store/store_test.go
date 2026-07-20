package store

import (
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/pika/db-mock/internal/domain"
)

func TestTranslateUniqueViolation(t *testing.T) {
	err := translate(&pgconn.PgError{Code: "23505"})
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("expected unique violation to become a resource conflict, got %v", err)
	}
}

func TestTaskInsertErrorExplainsActiveResourceConflict(t *testing.T) {
	err := taskInsertError(&pgconn.PgError{Code: "23505", ConstraintName: "tasks_active_resource_idx"})
	if !errors.Is(err, domain.ErrConflict) || !strings.Contains(err.Error(), "another operation") {
		t.Fatalf("expected an actionable active-task conflict, got %v", err)
	}
}
