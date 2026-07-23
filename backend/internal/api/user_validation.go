package api

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/pika/db-mock/internal/domain"
)

var managedUsernamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

func normalizeManagedUsername(value string) string {
	return strings.TrimSpace(value)
}

func normalizeDisplayName(value string) string {
	return strings.TrimSpace(value)
}

func validateManagedUsername(value string) error {
	length := utf8.RuneCountInString(value)
	if length < 3 || length > 64 {
		return fmt.Errorf("%w: username must contain between 3 and 64 characters", domain.ErrInvalid)
	}
	if !managedUsernamePattern.MatchString(value) {
		return fmt.Errorf("%w: username can only contain letters, numbers, dots, hyphens, and underscores", domain.ErrInvalid)
	}
	return nil
}

func validateDisplayName(value string) error {
	length := utf8.RuneCountInString(value)
	if length < 1 || length > 100 {
		return fmt.Errorf("%w: display name must contain between 1 and 100 characters", domain.ErrInvalid)
	}
	return nil
}

func validateNewPassword(value string) error {
	length := utf8.RuneCountInString(value)
	if length < 8 || length > 128 {
		return fmt.Errorf("%w: password must contain between 8 and 128 characters", domain.ErrInvalid)
	}
	return nil
}
