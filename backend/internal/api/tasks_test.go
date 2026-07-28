package api

import (
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

func TestParseTaskIDsAcceptsBoundedUniqueUUIDs(t *testing.T) {
	first, second := uuid.New(), uuid.New()
	ids, err := parseTaskIDs(first.String() + "," + second.String())
	if err != nil || len(ids) != 2 || ids[0] != first || ids[1] != second {
		t.Fatalf("parseTaskIDs() = %#v, %v", ids, err)
	}
}

func TestParseTaskIDsRejectsUnsafeQueries(t *testing.T) {
	id := uuid.New().String()
	for _, value := range []string{
		"not-a-uuid",
		id + "," + id,
		strings.TrimSuffix(strings.Repeat(uuid.New().String()+",", 101), ","),
	} {
		if _, err := parseTaskIDs(value); !errors.Is(err, domain.ErrInvalid) {
			t.Fatalf("parseTaskIDs(%q) error = %v, want invalid input", value, err)
		}
	}
}
