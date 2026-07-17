package webhooks

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	appcrypto "github.com/pika/db-mock/internal/crypto"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

type Dispatcher struct {
	store  *store.Store
	vault  *appcrypto.Vault
	logger *slog.Logger
	client *http.Client
}

func New(target *store.Store, vault *appcrypto.Vault, logger *slog.Logger) *Dispatcher {
	return &Dispatcher{store: target, vault: vault, logger: logger, client: &http.Client{Timeout: 15 * time.Second}}
}

func (d *Dispatcher) Start(ctx context.Context) { go d.loop(ctx) }

func (d *Dispatcher) loop(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.dispatch(ctx)
		}
	}
}

func (d *Dispatcher) dispatch(ctx context.Context) {
	for i := 0; i < 10; i++ {
		delivery, hook, err := d.store.ClaimWebhookDelivery(ctx)
		if err != nil {
			if err != domain.ErrNotFound {
				d.logger.Warn("claim webhook delivery", "error", err)
			}
			return
		}
		success, status, body, sendErr := d.send(ctx, delivery, hook)
		errorMessage := ""
		if sendErr != nil {
			errorMessage = sendErr.Error()
		}
		if err := d.store.FinishWebhookDelivery(ctx, delivery.ID, success, status, body, errorMessage, delivery.Attempts); err != nil {
			d.logger.Error("finish webhook delivery", "error", err)
		}
	}
}

func (d *Dispatcher) send(ctx context.Context, delivery store.WebhookDelivery, hook domain.Webhook) (bool, int, string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, hook.URL, bytes.NewReader(delivery.Payload))
	if err != nil {
		return false, 0, "", err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "DB-Mock/1")
	request.Header.Set("X-DBMock-Event", delivery.EventType)
	request.Header.Set("X-DBMock-Event-ID", delivery.EventID.String())
	if hook.EncryptedSecret != "" {
		secret, err := d.vault.Open(hook.EncryptedSecret, "webhook:"+hook.ID.String())
		if err != nil {
			return false, 0, "", fmt.Errorf("decrypt webhook secret: %w", err)
		}
		request.Header.Set("X-DBMock-Signature", appcrypto.SignHMAC(secret, delivery.Payload))
	}
	response, err := d.client.Do(request)
	if err != nil {
		return false, 0, "", err
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	success := response.StatusCode >= 200 && response.StatusCode < 300
	if !success {
		return false, response.StatusCode, string(body), fmt.Errorf("webhook returned HTTP %d", response.StatusCode)
	}
	return true, response.StatusCode, string(body), nil
}
