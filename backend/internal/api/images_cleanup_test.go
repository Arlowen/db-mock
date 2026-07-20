package api

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

func TestImageCleanupCutoffUsesSafeBounds(t *testing.T) {
	now := time.Date(2026, time.July, 20, 10, 0, 0, 0, time.UTC)
	days, cutoff, err := imageCleanupCutoff(0, now)
	if err != nil || days != 30 || !cutoff.Equal(now.Add(-30*24*time.Hour)) {
		t.Fatalf("unexpected default cleanup window: days=%d cutoff=%s err=%v", days, cutoff, err)
	}
	for _, value := range []int{-1, 3651} {
		if _, _, err = imageCleanupCutoff(value, now); !errors.Is(err, domain.ErrInvalid) {
			t.Fatalf("expected %d days to be rejected, got %v", value, err)
		}
	}
}

func TestUniqueImageIDsDropsEmptyAndDuplicateValues(t *testing.T) {
	first := uuid.New()
	second := uuid.New()
	result := uniqueImageIDs([]uuid.UUID{uuid.Nil, first, first, second})
	if len(result) != 2 || result[0] != first || result[1] != second {
		t.Fatalf("unexpected unique IDs: %#v", result)
	}
}
