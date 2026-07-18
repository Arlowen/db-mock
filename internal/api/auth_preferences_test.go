package api

import (
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

func TestSupportedLocale(t *testing.T) {
	for _, locale := range []string{"zh-CN", "en-US"} {
		if !supportedLocale(locale) {
			t.Fatalf("expected %q to be supported", locale)
		}
	}
	for _, locale := range []string{"", "en", "zh", "fr-FR"} {
		if supportedLocale(locale) {
			t.Fatalf("expected %q to be rejected", locale)
		}
	}
}

func TestValidateUserUpdatePreventsSelfDisable(t *testing.T) {
	actorID := uuid.New()
	otherID := uuid.New()
	enabled := false
	disabled := true

	if err := validateUserUpdate(actorID, actorID, &disabled); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("expected self-disable to conflict, got %v", err)
	}
	if err := validateUserUpdate(actorID, actorID, &enabled); err != nil {
		t.Fatalf("expected self-enable to be allowed, got %v", err)
	}
	if err := validateUserUpdate(actorID, otherID, &disabled); err != nil {
		t.Fatalf("expected another user to be disabled, got %v", err)
	}
	if err := validateUserUpdate(actorID, actorID, nil); err != nil {
		t.Fatalf("expected an unchanged status to be allowed, got %v", err)
	}
}
