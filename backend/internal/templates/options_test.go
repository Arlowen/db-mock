package templates

import (
	"errors"
	"testing"

	"github.com/pika/db-mock/internal/domain"
)

func numberPointer(value float64) *float64 { return &value }

func TestResolveTemplateParametersAppliesTypedValuesAndDefaults(t *testing.T) {
	definitions := []TemplateParameter{
		{Key: "timezone", Type: "select", Environment: "TZ", Label: "Time zone", Required: true,
			Default: "UTC", Options: []TemplateParameterOption{{Value: "UTC"}, {Value: "Asia/Shanghai"}}},
		{Key: "maxConnections", Type: "number", Environment: "MAX_CONNECTIONS", Label: "Maximum connections",
			Required: true, Default: 100, Min: numberPointer(10), Max: numberPointer(1000), Step: numberPointer(10)},
		{Key: "slowQueryLog", Type: "boolean", Environment: "SLOW_QUERY_LOG", Label: "Slow query log", Default: false},
		{Key: "clusterName", Type: "text", Environment: "CLUSTER_NAME", Label: "Cluster name"},
	}
	values, environment, err := ResolveTemplateParameters(definitions, map[string]any{
		"timezone": "Asia/Shanghai", "maxConnections": float64(250), "slowQueryLog": true,
	}, map[string]string{"LANG": "C.UTF-8"}, true)
	if err != nil {
		t.Fatal(err)
	}
	if values["timezone"] != "Asia/Shanghai" || values["maxConnections"] != float64(250) || values["slowQueryLog"] != true {
		t.Fatalf("normalized values = %#v", values)
	}
	if _, exists := values["clusterName"]; exists {
		t.Fatalf("an omitted optional value should stay absent: %#v", values)
	}
	want := map[string]string{"LANG": "C.UTF-8", "TZ": "Asia/Shanghai", "MAX_CONNECTIONS": "250", "SLOW_QUERY_LOG": "true"}
	for key, value := range want {
		if environment[key] != value {
			t.Fatalf("environment[%s] = %q, want %q (%#v)", key, environment[key], value, environment)
		}
	}
}

func TestResolveTemplateParametersRejectsInvalidOrConflictingValues(t *testing.T) {
	definitions := []TemplateParameter{{Key: "workers", Type: "number", Environment: "WORKERS", Label: "Workers",
		Required: true, Min: numberPointer(1), Max: numberPointer(16)}}
	for name, submitted := range map[string]map[string]any{
		"missing required value": {},
		"outside range":          {"workers": float64(32)},
		"unknown parameter":      {"workers": float64(4), "other": "value"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, _, err := ResolveTemplateParameters(definitions, submitted, nil, true); !errors.Is(err, domain.ErrInvalid) {
				t.Fatalf("expected invalid parameter input, got %v", err)
			}
		})
	}
	if _, _, err := ResolveTemplateParameters(definitions, map[string]any{"workers": float64(4)},
		map[string]string{"WORKERS": "8"}, true); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("expected an environment collision, got %v", err)
	}
	values, _, err := ResolveTemplateParameters(definitions, map[string]any{"workers": float64(4), "removed": true}, nil, false)
	if err != nil || len(values) != 1 || values["workers"] != float64(4) {
		t.Fatalf("upgrade compatibility values = %#v, %v", values, err)
	}
}

func TestNormalizeTemplateOptionsRejectsUnsafeContracts(t *testing.T) {
	for name, parameters := range map[string][]TemplateParameter{
		"reserved environment": {{Key: "password", Type: "text", Environment: "DBMOCK_DB_PASSWORD", Label: "Password"}},
		"duplicate key": {
			{Key: "mode", Type: "text", Environment: "MODE", Label: "Mode"},
			{Key: "mode", Type: "text", Environment: "OTHER_MODE", Label: "Other mode"},
		},
		"invalid select default": {{Key: "mode", Type: "select", Environment: "MODE", Label: "Mode", Default: "invalid",
			Options: []TemplateParameterOption{{Value: "safe"}}}},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := NormalizeTemplateParameters(parameters); !errors.Is(err, domain.ErrInvalid) {
				t.Fatalf("expected invalid contract, got %v", err)
			}
		})
	}
	if _, err := NormalizeResourceProfiles([]ResourceProfile{{Name: "small", CPU: 0.5, MemoryBytes: 1024, DiskBytes: 1024}}, 1, 1024, 1024); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("expected a below-minimum profile to fail, got %v", err)
	}
}
