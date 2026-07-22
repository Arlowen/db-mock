package images

import (
	"context"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pika/db-mock/internal/db"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

func openUploadCleanupTest(t *testing.T) (context.Context, *pgxpool.Pool) {
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
	schema := "image_cleanup_" + strings.ReplaceAll(uuid.NewString(), "-", "")
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

func TestCleanupExpiredUploadsRemovesStaleFilesAndRecords(t *testing.T) {
	ctx, pool := openUploadCleanupTest(t)
	target := store.New(pool)
	userID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,username,password_hash)
		VALUES($1,'image-cleanup-test','hash')`, userID); err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	uploadDirectory := filepath.Join(directory, "uploads")
	if err := os.MkdirAll(uploadDirectory, 0o750); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	cutoff := now.Add(-incompleteUploadRetention)
	type uploadFixture struct {
		upload domain.Upload
		path   string
		stale  bool
	}
	fixtures := []uploadFixture{
		{upload: domain.Upload{ID: uuid.New(), Filename: "old-upload.tar", TotalBytes: 20, ReceivedBytes: 10, Status: "uploading", CreatedBy: userID}, stale: true},
		{upload: domain.Upload{ID: uuid.New(), Filename: "old-complete.tar", TotalBytes: 20, ReceivedBytes: 20, Status: "complete", CreatedBy: userID}, stale: true},
		{upload: domain.Upload{ID: uuid.New(), Filename: "recent-upload.tar", TotalBytes: 20, ReceivedBytes: 10, Status: "uploading", CreatedBy: userID}},
	}
	for index := range fixtures {
		fixtures[index].path = filepath.Join(uploadDirectory, fixtures[index].upload.ID.String()+".part")
		fixtures[index].upload.TemporaryPath = fixtures[index].path
		if err := os.WriteFile(fixtures[index].path, []byte("partial archive"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := target.CreateUpload(ctx, fixtures[index].upload); err != nil {
			t.Fatal(err)
		}
		updatedAt := cutoff.Add(time.Hour)
		if fixtures[index].stale {
			updatedAt = cutoff.Add(-time.Hour)
		}
		if _, err := pool.Exec(ctx, `UPDATE uploads SET updated_at=$2 WHERE id=$1`, fixtures[index].upload.ID, updatedAt); err != nil {
			t.Fatal(err)
		}
	}

	count, err := New(target, directory, 1).CleanupExpiredUploads(ctx, cutoff)
	if err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("cleaned upload count = %d, want 2", count)
	}
	for _, fixture := range fixtures {
		_, statErr := os.Stat(fixture.path)
		_, getErr := target.GetUpload(ctx, fixture.upload.ID)
		if fixture.stale {
			if !os.IsNotExist(statErr) {
				t.Fatalf("stale file %s was not removed: %v", filepath.Base(fixture.path), statErr)
			}
			if !errors.Is(getErr, domain.ErrNotFound) {
				t.Fatalf("stale upload record still exists: %v", getErr)
			}
			continue
		}
		if statErr != nil {
			t.Fatalf("recent file was removed: %v", statErr)
		}
		if getErr != nil {
			t.Fatalf("recent upload record was removed: %v", getErr)
		}
	}
}
