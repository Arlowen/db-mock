package store

import (
	"errors"
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
