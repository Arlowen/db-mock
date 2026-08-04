package store_test

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

func TestSingleAdministratorProfileUpdatePreservesAuthorityAndSession(t *testing.T) {
	ctx, pool := openInstanceStoreTest(t)
	target := store.New(pool)

	admin, err := target.CreateInitialUser(ctx, "admin", "Initial administrator", "zh-CN", "hash")
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := target.CreateSession(ctx, admin.ID, time.Hour, "127.0.0.1", "integration test")
	if err != nil {
		t.Fatal(err)
	}

	updated, err := target.UpdateOwnProfile(ctx, admin.ID, "Database operator", "en-US")
	if err != nil {
		t.Fatal(err)
	}
	if updated.Username != admin.Username || updated.DisplayName != "Database operator" ||
		updated.Locale != "en-US" || updated.Role != domain.RoleAdmin || updated.DisabledAt != nil ||
		updated.PasswordHash != "hash" {
		t.Fatalf("updated administrator = %#v", updated)
	}
	resolved, _, err := target.ResolveSession(ctx, token)
	if err != nil || resolved.DisplayName != updated.DisplayName || resolved.Role != domain.RoleAdmin {
		t.Fatalf("active session no longer resolves updated administrator: user=%#v err=%v", resolved, err)
	}

	var userCount int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM users").Scan(&userCount); err != nil || userCount != 1 {
		t.Fatalf("user count = %d, err=%v", userCount, err)
	}
	if _, err = target.UpdateOwnProfile(ctx, uuid.New(), "Missing", "zh-CN"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("missing user update error = %v, want not found", err)
	}
}
