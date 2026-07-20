package settings

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/pika/db-mock/internal/domain"
)

const DefaultTimezone = "Asia/Shanghai"

func ValidateTimezone(value string) error {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 || value == "Local" {
		return fmt.Errorf("%w: timezone must be a valid IANA timezone name", domain.ErrInvalid)
	}
	if _, err := time.LoadLocation(value); err != nil {
		return fmt.Errorf("%w: timezone must be a valid IANA timezone name", domain.ErrInvalid)
	}
	return nil
}

func NormalizeTimezone(raw json.RawMessage) (json.RawMessage, error) {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("%w: timezone must be a JSON string", domain.ErrInvalid)
	}
	value = strings.TrimSpace(value)
	if err := ValidateTimezone(value); err != nil {
		return nil, err
	}
	result, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("marshal timezone: %w", err)
	}
	return result, nil
}

func EffectiveTimezone(raw json.RawMessage, fallback string) string {
	normalized, err := NormalizeTimezone(raw)
	if err == nil {
		var value string
		if json.Unmarshal(normalized, &value) == nil {
			return value
		}
	}
	fallback = strings.TrimSpace(fallback)
	if ValidateTimezone(fallback) == nil {
		return fallback
	}
	return DefaultTimezone
}
