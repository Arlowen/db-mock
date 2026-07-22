package store_test

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pika/db-mock/internal/db"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

func TestUserRolesProtectTheLastAdministratorAndRevokeSessions(t *testing.T) {
	databaseURL := os.Getenv("DBMOCK_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DBMOCK_TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	adminPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer adminPool.Close()
	schema := "user_roles_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = adminPool.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal(err)
	}
	defer adminPool.Exec(ctx, `DROP SCHEMA `+schema+` CASCADE`)
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

	first, err := target.CreateInitialUser(ctx, "first-admin", "First", "en-US", "hash")
	if err != nil || first.Role != domain.RoleAdmin {
		t.Fatalf("initial user = %#v, err=%v", first, err)
	}
	viewer, err := target.CreateUser(ctx, "viewer", "Viewer", "en-US", "", "hash")
	if err != nil || viewer.Role != domain.RoleViewer {
		t.Fatalf("default user = %#v, err=%v", viewer, err)
	}
	wantedViewer := domain.RoleViewer
	if _, err = target.UpdateUser(ctx, first.ID, "", "", nil, "", &wantedViewer, nil); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("last administrator demotion must conflict, got %v", err)
	}
	disabled := true
	if _, err = target.UpdateUser(ctx, first.ID, "", "", &disabled, "", nil, nil); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("last administrator disable must conflict, got %v", err)
	}

	second, err := target.CreateUser(ctx, "second-admin", "Second", "en-US", domain.RoleAdmin, "hash")
	if err != nil {
		t.Fatal(err)
	}
	firstToken, _, err := target.CreateSession(ctx, first.ID, time.Hour, "127.0.0.1", "test")
	if err != nil {
		t.Fatal(err)
	}
	secondToken, _, err := target.CreateSession(ctx, second.ID, time.Hour, "127.0.0.1", "test")
	if err != nil {
		t.Fatal(err)
	}

	type result struct {
		id  uuid.UUID
		err error
	}
	results := make(chan result, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	start := make(chan struct{})
	for _, id := range []uuid.UUID{first.ID, second.ID} {
		go func(userID uuid.UUID) {
			ready.Done()
			<-start
			_, updateErr := target.UpdateUser(ctx, userID, "", "", nil, "", &wantedViewer, nil)
			results <- result{id: userID, err: updateErr}
		}(id)
	}
	ready.Wait()
	close(start)
	var demotedID, remainingID uuid.UUID
	for range 2 {
		item := <-results
		if item.err == nil {
			demotedID = item.id
		} else if errors.Is(item.err, domain.ErrConflict) {
			remainingID = item.id
		} else {
			t.Fatalf("unexpected concurrent role update error: %v", item.err)
		}
	}
	if demotedID == uuid.Nil || remainingID == uuid.Nil || demotedID == remainingID {
		t.Fatalf("expected one demotion and one protected administrator: demoted=%s remaining=%s", demotedID, remainingID)
	}
	var activeAdmins int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE role='admin' AND disabled_at IS NULL`).Scan(&activeAdmins); err != nil {
		t.Fatal(err)
	}
	if activeAdmins != 1 {
		t.Fatalf("active administrator count = %d, want 1", activeAdmins)
	}
	tokens := map[uuid.UUID]string{first.ID: firstToken, second.ID: secondToken}
	if _, _, err = target.ResolveSession(ctx, tokens[demotedID]); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("demoted user session must be revoked, got %v", err)
	}
	remaining, _, err := target.ResolveSession(ctx, tokens[remainingID])
	if err != nil || remaining.Role != domain.RoleAdmin {
		t.Fatalf("remaining administrator session = %#v, err=%v", remaining, err)
	}
}
