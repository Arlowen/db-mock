package api

import (
	"errors"
	"testing"

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

func TestManagedUserCredentialValidation(t *testing.T) {
	for _, value := range []string{"admin", "ops.user", "qa-user_1"} {
		if err := validateManagedUsername(value); err != nil {
			t.Fatalf("expected username %q to be valid: %v", value, err)
		}
	}
	for _, value := range []string{"ab", "ops user", "-operator"} {
		if err := validateManagedUsername(value); !errors.Is(err, domain.ErrInvalid) {
			t.Fatalf("expected username %q to be invalid, got %v", value, err)
		}
	}
	if err := validateDisplayName("管理员"); err != nil {
		t.Fatalf("expected display name to be valid: %v", err)
	}
	if err := validateDisplayName(""); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("expected empty display name to be invalid, got %v", err)
	}
	if err := validateNewPassword("password"); err != nil {
		t.Fatalf("expected eight-character password to be valid: %v", err)
	}
	if err := validateNewPassword("short"); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("expected short password to be invalid, got %v", err)
	}
}
