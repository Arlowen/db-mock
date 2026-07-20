package api

import (
	"errors"
	"testing"
	"time"

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

func TestUserUpdateAuditAction(t *testing.T) {
	actorID := uuid.New()
	otherID := uuid.New()
	disabledAt := time.Now()
	enabled := false
	disabled := true
	tests := []struct {
		name   string
		target uuid.UUID
		before domain.User
		input  userUpdateRequest
		want   string
	}{
		{name: "disable", target: otherID, input: userUpdateRequest{Disabled: &disabled}, want: "user.disable"},
		{name: "enable", target: otherID, before: domain.User{DisabledAt: &disabledAt}, input: userUpdateRequest{Disabled: &enabled}, want: "user.enable"},
		{name: "reset another password", target: otherID, input: userUpdateRequest{Password: "new-secret"}, want: "user.password_reset"},
		{name: "change own password", target: actorID, input: userUpdateRequest{Password: "new-secret"}, want: "user.password_update"},
		{name: "ordinary update", target: otherID, input: userUpdateRequest{DisplayName: "New name"}, want: "user.update"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := userUpdateAuditAction(actorID, test.target, test.before, test.input); got != test.want {
				t.Fatalf("expected %q, got %q", test.want, got)
			}
		})
	}
}

func TestUserUpdateAuditChangesNeverIncludePassword(t *testing.T) {
	disabledAt := time.Now()
	before := domain.User{DisplayName: "Before", Locale: "zh-CN"}
	after := domain.User{DisplayName: "After", Locale: "en-US", DisabledAt: &disabledAt}
	changes := userUpdateAuditChanges(before, after, userUpdateRequest{Password: "plaintext-secret"})

	if changes["passwordChanged"] != true || changes["sessionsRevoked"] != true {
		t.Fatalf("expected password and session flags, got %#v", changes)
	}
	if _, exists := changes["password"]; exists {
		t.Fatalf("audit changes must not contain a password: %#v", changes)
	}
	if changes["status"] == nil || changes["displayName"] == nil || changes["locale"] == nil {
		t.Fatalf("expected non-secret field changes, got %#v", changes)
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
