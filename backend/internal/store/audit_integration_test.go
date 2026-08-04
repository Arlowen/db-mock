package store_test

import (
	"strings"
	"testing"

	"github.com/pika/db-mock/internal/store"
)

func TestCoreAuditWriteRemainsDurableAndRedacted(t *testing.T) {
	ctx, pool := openInstanceStoreTest(t)
	target := store.New(pool)
	if err := target.AddAudit(ctx, store.AuditInput{
		Username: "admin", Action: "instance.connection.view", ResourceType: "instance",
		Result: "success", Changes: map[string]any{
			"credentialChanged": true,
			"password":          "must-not-be-stored",
		},
	}); err != nil {
		t.Fatal(err)
	}
	var action, changes string
	if err := pool.QueryRow(ctx, `SELECT action,changes::text FROM audit_logs ORDER BY id DESC LIMIT 1`).Scan(&action, &changes); err != nil {
		t.Fatal(err)
	}
	if action != "instance.connection.view" || !strings.Contains(changes, `"credentialChanged": true`) ||
		!strings.Contains(changes, `"password": "[REDACTED]"`) || strings.Contains(changes, "must-not-be-stored") {
		t.Fatalf("audit row was not durable and safely redacted: action=%q changes=%s", action, changes)
	}
}
