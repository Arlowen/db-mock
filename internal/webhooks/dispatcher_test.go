package webhooks

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	appcrypto "github.com/pika/db-mock/internal/crypto"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

func testDispatcher(t *testing.T) *Dispatcher {
	t.Helper()
	vault, err := appcrypto.NewVault(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return &Dispatcher{vault: vault, client: newWebhookClient()}
}

func TestWebhookTestUsesSingleAttempt(t *testing.T) {
	if got := maxAttempts("webhook.test"); got != 1 {
		t.Fatalf("test delivery attempts = %d, want 1", got)
	}
	if got := maxAttempts("alert.created"); got != 5 {
		t.Fatalf("event delivery attempts = %d, want 5", got)
	}
}

func TestSendWebhookHeadersAndSignature(t *testing.T) {
	dispatcher := testDispatcher(t)
	hookID := uuid.New()
	secret, err := dispatcher.vault.Seal([]byte("delivery-secret"), "webhook:"+hookID.String())
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte(`{"event":"alert.created"}`)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-DBMock-Event") != "alert.created" || r.Header.Get("X-DBMock-Event-ID") == "" {
			t.Errorf("missing event headers: %#v", r.Header)
		}
		if got, want := r.Header.Get("X-DBMock-Signature"), appcrypto.SignHMAC([]byte("delivery-secret"), payload); got != want {
			t.Errorf("signature = %q, want %q", got, want)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	success, status, _, err := dispatcher.send(context.Background(), store.WebhookDelivery{
		EventID: uuid.New(), EventType: "alert.created", Payload: payload,
	}, domain.Webhook{ID: hookID, URL: server.URL, EncryptedSecret: secret})
	if err != nil || !success || status != http.StatusNoContent {
		t.Fatalf("send result success=%v status=%d err=%v", success, status, err)
	}
}

func TestSendWebhookDoesNotFollowRedirects(t *testing.T) {
	dispatcher := testDispatcher(t)
	redirected := false
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirected = true }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()

	success, status, _, err := dispatcher.send(context.Background(), store.WebhookDelivery{
		EventID: uuid.New(), EventType: "webhook.test", Payload: []byte(`{}`),
	}, domain.Webhook{ID: uuid.New(), URL: server.URL})
	if err == nil || success || status != http.StatusTemporaryRedirect {
		t.Fatalf("redirect result success=%v status=%d err=%v", success, status, err)
	}
	if redirected {
		t.Fatal("webhook client followed redirect")
	}
}
