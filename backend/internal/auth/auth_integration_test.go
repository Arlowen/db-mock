package auth_test

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pika/db-mock/internal/auth"
	appcrypto "github.com/pika/db-mock/internal/crypto"
	"github.com/pika/db-mock/internal/db"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

func TestChangePasswordVerifiesCurrentPasswordAndRevokesOtherSessions(t *testing.T) {
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
	schema := "auth_password_" + strings.ReplaceAll(uuid.NewString(), "-", "")
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
	target := store.New(pool)

	oldHash, err := appcrypto.HashPassword("old-password")
	if err != nil {
		t.Fatal(err)
	}
	user, err := target.CreateInitialUser(ctx, "operator", "Operator", "en-US", oldHash)
	if err != nil {
		t.Fatal(err)
	}
	currentToken, currentSession, err := target.CreateSession(ctx, user.ID, time.Hour, "127.0.0.1", "current-browser")
	if err != nil {
		t.Fatal(err)
	}
	otherToken, _, err := target.CreateSession(ctx, user.ID, time.Hour, "127.0.0.2", "other-browser")
	if err != nil {
		t.Fatal(err)
	}
	user, _, err = target.ResolveSession(ctx, currentToken)
	if err != nil {
		t.Fatal(err)
	}
	service := auth.New(target, time.Hour, false)

	if err = service.ChangePassword(ctx, user, currentSession.ID, "wrong-password", "new-password"); !errors.Is(err, domain.ErrInvalid) || !strings.Contains(err.Error(), "current password is incorrect") {
		t.Fatalf("wrong current password error = %v", err)
	}
	if _, _, err = target.ResolveSession(ctx, otherToken); err != nil {
		t.Fatalf("rejected change revoked another session: %v", err)
	}
	if err = service.ChangePassword(ctx, user, currentSession.ID, "old-password", "old-password"); !errors.Is(err, domain.ErrInvalid) || !strings.Contains(err.Error(), "must be different") {
		t.Fatalf("reused password error = %v", err)
	}

	if err = service.ChangePassword(ctx, user, currentSession.ID, "old-password", "new-password"); err != nil {
		t.Fatal(err)
	}
	currentUser, _, err := target.ResolveSession(ctx, currentToken)
	if err != nil || !appcrypto.VerifyPassword(currentUser.PasswordHash, "new-password") {
		t.Fatalf("current session did not retain the new password hash: user=%#v err=%v", currentUser, err)
	}
	if _, _, err = target.ResolveSession(ctx, otherToken); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("other session must be revoked, got %v", err)
	}
	if err = service.ChangePassword(ctx, user, currentSession.ID, "old-password", "third-password"); !errors.Is(err, domain.ErrConflict) || !strings.Contains(err.Error(), "another session") {
		t.Fatalf("stale password update must conflict, got %v", err)
	}
	if _, _, err = service.Login(ctx, "operator", "old-password", "127.0.0.3", "old-login"); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("old password login error = %v", err)
	}
	if _, _, err = service.Login(ctx, "operator", "new-password", "127.0.0.3", "new-login"); err != nil {
		t.Fatalf("new password login failed: %v", err)
	}
}
