package instances

import (
	"errors"
	"testing"
	"time"

	"github.com/pika/db-mock/internal/domain"
)

func TestNextBackupRunDailyUsesPolicyTimezone(t *testing.T) {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	input := BackupPolicyInput{Enabled: true, Frequency: "daily", Hour: 2, Minute: 30,
		Timezone: "Asia/Shanghai", RetentionCount: 7}
	after := time.Date(2026, 7, 21, 17, 0, 0, 0, time.UTC) // 01:00 in Shanghai.
	got := nextBackupRun(after, input, location)
	want := time.Date(2026, 7, 21, 18, 30, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("next daily run = %s, want %s", got, want)
	}
	got = nextBackupRun(want, input, location)
	want = time.Date(2026, 7, 22, 18, 30, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("run exactly on the boundary must advance: got %s, want %s", got, want)
	}
}

func TestNextBackupRunWeeklyAdvancesWithoutCatchUp(t *testing.T) {
	location := time.UTC
	input := BackupPolicyInput{Enabled: true, Frequency: "weekly", Weekday: int(time.Monday), Hour: 3,
		Minute: 15, Timezone: "UTC", RetentionCount: 4}
	after := time.Date(2026, 7, 20, 4, 0, 0, 0, time.UTC) // Monday after the requested time.
	got := nextBackupRun(after, input, location)
	want := time.Date(2026, 7, 27, 3, 15, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("next weekly run = %s, want %s", got, want)
	}
}

func TestNextBackupRunRemainsFutureAcrossDaylightSavingChange(t *testing.T) {
	location, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	input := BackupPolicyInput{Enabled: true, Frequency: "daily", Hour: 2, Minute: 30,
		Timezone: "America/New_York", RetentionCount: 7}
	after := time.Date(2026, 3, 8, 6, 0, 0, 0, time.UTC)
	got := nextBackupRun(after, input, location)
	if !got.After(after) {
		t.Fatalf("DST transition produced a non-future run: after=%s run=%s", after, got)
	}
	if got.Sub(after) > 25*time.Hour {
		t.Fatalf("DST transition delayed the run by more than one local day: after=%s run=%s", after, got)
	}
	wall := got.In(location)
	if wall.Hour() != 3 || wall.Minute() != 0 {
		t.Fatalf("nonexistent 02:30 should run at the first valid local minute, got %s", wall)
	}
}

func TestValidateBackupPolicyRejectsUnsafeValues(t *testing.T) {
	valid := BackupPolicyInput{Enabled: true, Frequency: "daily", Weekday: 0, Hour: 2, Minute: 30,
		Timezone: "Asia/Shanghai", RetentionCount: 7}
	if _, err := validateBackupPolicy(valid); err != nil {
		t.Fatalf("valid policy rejected: %v", err)
	}
	for name, mutate := range map[string]func(*BackupPolicyInput){
		"frequency": func(input *BackupPolicyInput) { input.Frequency = "hourly" },
		"weekday":   func(input *BackupPolicyInput) { input.Weekday = 7 },
		"hour":      func(input *BackupPolicyInput) { input.Hour = 24 },
		"minute":    func(input *BackupPolicyInput) { input.Minute = 60 },
		"timezone":  func(input *BackupPolicyInput) { input.Timezone = "Local" },
		"retention": func(input *BackupPolicyInput) { input.RetentionCount = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			input := valid
			mutate(&input)
			if _, err := validateBackupPolicy(input); !errors.Is(err, domain.ErrInvalid) {
				t.Fatalf("expected invalid policy, got %v", err)
			}
		})
	}
}
