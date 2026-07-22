package templates

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/pika/db-mock/internal/domain"
)

const (
	maxTemplateParameters       = 32
	maxTemplateParameterOptions = 50
	maxTemplateResourceProfiles = 8
)

var templateParameterKeyPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)

type TemplateParameterOption struct {
	Value   string `json:"value" yaml:"value"`
	Label   string `json:"label" yaml:"label"`
	LabelZH string `json:"labelZh,omitempty" yaml:"labelZh,omitempty"`
}

// TemplateParameter defines a non-secret instance option that is rendered as
// a quoted container environment value through ExtraEnvironment.
type TemplateParameter struct {
	Key           string                    `json:"key" yaml:"key"`
	Type          string                    `json:"type" yaml:"type"`
	Environment   string                    `json:"environment" yaml:"environment"`
	Label         string                    `json:"label" yaml:"label"`
	LabelZH       string                    `json:"labelZh,omitempty" yaml:"labelZh,omitempty"`
	Description   string                    `json:"description,omitempty" yaml:"description,omitempty"`
	DescriptionZH string                    `json:"descriptionZh,omitempty" yaml:"descriptionZh,omitempty"`
	Required      bool                      `json:"required" yaml:"required"`
	Default       any                       `json:"default,omitempty" yaml:"default,omitempty"`
	Min           *float64                  `json:"min,omitempty" yaml:"min,omitempty"`
	Max           *float64                  `json:"max,omitempty" yaml:"max,omitempty"`
	Step          *float64                  `json:"step,omitempty" yaml:"step,omitempty"`
	Options       []TemplateParameterOption `json:"options,omitempty" yaml:"options,omitempty"`
}

type ResourceProfile struct {
	Name        string  `json:"name" yaml:"name"`
	Label       string  `json:"label,omitempty" yaml:"label,omitempty"`
	LabelZH     string  `json:"labelZh,omitempty" yaml:"labelZh,omitempty"`
	CPU         float64 `json:"cpu" yaml:"cpu"`
	MemoryBytes int64   `json:"memoryBytes" yaml:"memoryBytes"`
	DiskBytes   int64   `json:"diskBytes" yaml:"diskBytes"`
}

func NormalizeTemplateParameters(input []TemplateParameter) ([]TemplateParameter, error) {
	if len(input) > maxTemplateParameters {
		return nil, fmt.Errorf("%w: a template can declare at most %d parameters", domain.ErrInvalid, maxTemplateParameters)
	}
	result := make([]TemplateParameter, 0, len(input))
	keys, environments := make(map[string]struct{}, len(input)), make(map[string]struct{}, len(input))
	for _, original := range input {
		parameter := original
		parameter.Key = strings.TrimSpace(parameter.Key)
		parameter.Type = strings.ToLower(strings.TrimSpace(parameter.Type))
		parameter.Environment = strings.TrimSpace(parameter.Environment)
		parameter.Label = strings.TrimSpace(parameter.Label)
		parameter.LabelZH = strings.TrimSpace(parameter.LabelZH)
		parameter.Description = strings.TrimSpace(parameter.Description)
		parameter.DescriptionZH = strings.TrimSpace(parameter.DescriptionZH)
		if !templateParameterKeyPattern.MatchString(parameter.Key) {
			return nil, fmt.Errorf("%w: template parameter key %q is invalid", domain.ErrInvalid, parameter.Key)
		}
		if _, exists := keys[parameter.Key]; exists {
			return nil, fmt.Errorf("%w: template parameter key %q is duplicated", domain.ErrInvalid, parameter.Key)
		}
		keys[parameter.Key] = struct{}{}
		if !validEnvironmentKey(parameter.Environment) || reservedEnvironmentKey(parameter.Environment) {
			return nil, fmt.Errorf("%w: template parameter %q has an invalid or reserved environment name", domain.ErrInvalid, parameter.Key)
		}
		if _, exists := environments[parameter.Environment]; exists {
			return nil, fmt.Errorf("%w: template parameter environment %q is duplicated", domain.ErrInvalid, parameter.Environment)
		}
		environments[parameter.Environment] = struct{}{}
		if parameter.Label == "" {
			parameter.Label = parameter.Key
		}
		if len([]rune(parameter.Label)) > 120 || len([]rune(parameter.LabelZH)) > 120 ||
			len([]rune(parameter.Description)) > 500 || len([]rune(parameter.DescriptionZH)) > 500 {
			return nil, fmt.Errorf("%w: template parameter %q text is too long", domain.ErrInvalid, parameter.Key)
		}
		if parameter.Type != "text" && parameter.Type != "number" && parameter.Type != "boolean" && parameter.Type != "select" {
			return nil, fmt.Errorf("%w: template parameter %q has unsupported type %q", domain.ErrInvalid, parameter.Key, parameter.Type)
		}
		if parameter.Type == "select" {
			if len(parameter.Options) == 0 || len(parameter.Options) > maxTemplateParameterOptions {
				return nil, fmt.Errorf("%w: select parameter %q must declare 1-%d options", domain.ErrInvalid, parameter.Key, maxTemplateParameterOptions)
			}
			seen := make(map[string]struct{}, len(parameter.Options))
			for index := range parameter.Options {
				option := &parameter.Options[index]
				option.Value = strings.TrimSpace(option.Value)
				option.Label = strings.TrimSpace(option.Label)
				option.LabelZH = strings.TrimSpace(option.LabelZH)
				if option.Value == "" || strings.ContainsRune(option.Value, '\x00') || len([]rune(option.Value)) > 1024 {
					return nil, fmt.Errorf("%w: select parameter %q has an invalid option", domain.ErrInvalid, parameter.Key)
				}
				if _, exists := seen[option.Value]; exists {
					return nil, fmt.Errorf("%w: select parameter %q has duplicate option %q", domain.ErrInvalid, parameter.Key, option.Value)
				}
				seen[option.Value] = struct{}{}
				if option.Label == "" {
					option.Label = option.Value
				}
			}
		} else if len(parameter.Options) != 0 {
			return nil, fmt.Errorf("%w: only select parameters can declare options", domain.ErrInvalid)
		}
		if parameter.Type != "number" && (parameter.Min != nil || parameter.Max != nil || parameter.Step != nil) {
			return nil, fmt.Errorf("%w: only number parameters can declare min, max, or step", domain.ErrInvalid)
		}
		if parameter.Min != nil && (!finite(*parameter.Min) || parameter.Max != nil && *parameter.Min > *parameter.Max) {
			return nil, fmt.Errorf("%w: template parameter %q has invalid numeric bounds", domain.ErrInvalid, parameter.Key)
		}
		if parameter.Max != nil && !finite(*parameter.Max) || parameter.Step != nil && (!finite(*parameter.Step) || *parameter.Step <= 0) {
			return nil, fmt.Errorf("%w: template parameter %q has invalid numeric bounds", domain.ErrInvalid, parameter.Key)
		}
		if parameter.Default != nil {
			value, _, err := normalizeTemplateParameterValue(parameter, parameter.Default)
			if err != nil {
				return nil, err
			}
			parameter.Default = value
		}
		result = append(result, parameter)
	}
	return result, nil
}

func NormalizeResourceProfiles(input []ResourceProfile, minCPU float64, minMemory, minDisk int64) ([]ResourceProfile, error) {
	if len(input) > maxTemplateResourceProfiles {
		return nil, fmt.Errorf("%w: a template can declare at most %d resource profiles", domain.ErrInvalid, maxTemplateResourceProfiles)
	}
	result := make([]ResourceProfile, 0, len(input))
	seen := make(map[string]struct{}, len(input))
	for _, original := range input {
		profile := original
		profile.Name = strings.TrimSpace(profile.Name)
		profile.Label = strings.TrimSpace(profile.Label)
		profile.LabelZH = strings.TrimSpace(profile.LabelZH)
		if !templateParameterKeyPattern.MatchString(profile.Name) {
			return nil, fmt.Errorf("%w: resource profile name %q is invalid", domain.ErrInvalid, profile.Name)
		}
		if _, exists := seen[profile.Name]; exists {
			return nil, fmt.Errorf("%w: resource profile name %q is duplicated", domain.ErrInvalid, profile.Name)
		}
		seen[profile.Name] = struct{}{}
		if !finite(profile.CPU) || profile.CPU < minCPU || profile.MemoryBytes < minMemory || profile.DiskBytes < minDisk {
			return nil, fmt.Errorf("%w: resource profile %q is below the template minimum", domain.ErrInvalid, profile.Name)
		}
		if profile.Label == "" {
			profile.Label = profile.Name
		}
		result = append(result, profile)
	}
	return result, nil
}

// ResolveTemplateParameters validates submitted values, applies immutable
// defaults, and produces the environment fragment rendered into Compose.
// Strict mode rejects values that are not declared by the selected version;
// upgrades use non-strict mode so parameters removed by a newer version drop
// cleanly while retained values continue to work.
func ResolveTemplateParameters(definitions []TemplateParameter, submitted map[string]any, extraEnvironment map[string]string, strict bool) (map[string]any, map[string]string, error) {
	parameters, err := NormalizeTemplateParameters(definitions)
	if err != nil {
		return nil, nil, err
	}
	known := make(map[string]TemplateParameter, len(parameters))
	for _, parameter := range parameters {
		known[parameter.Key] = parameter
	}
	if strict {
		for key := range submitted {
			if _, exists := known[key]; !exists {
				return nil, nil, fmt.Errorf("%w: template parameter %q is not declared by this version", domain.ErrInvalid, key)
			}
		}
	}
	environment := make(map[string]string, len(extraEnvironment)+len(parameters))
	for key, value := range extraEnvironment {
		if !validEnvironmentKey(key) || reservedEnvironmentKey(key) || strings.ContainsRune(value, '\x00') {
			return nil, nil, fmt.Errorf("%w: environment override %q is invalid or reserved", domain.ErrInvalid, key)
		}
		environment[key] = value
	}
	values := make(map[string]any, len(parameters))
	for _, parameter := range parameters {
		value, exists := submitted[parameter.Key]
		if !exists || value == nil {
			value, exists = parameter.Default, parameter.Default != nil
		}
		if !exists {
			if parameter.Required {
				return nil, nil, fmt.Errorf("%w: template parameter %q is required", domain.ErrInvalid, parameter.Key)
			}
			continue
		}
		normalized, rendered, normalizeErr := normalizeTemplateParameterValue(parameter, value)
		if normalizeErr != nil {
			return nil, nil, normalizeErr
		}
		if parameter.Required && parameter.Type != "boolean" && strings.TrimSpace(rendered) == "" {
			return nil, nil, fmt.Errorf("%w: template parameter %q is required", domain.ErrInvalid, parameter.Key)
		}
		if _, exists = environment[parameter.Environment]; exists {
			return nil, nil, fmt.Errorf("%w: environment override %q conflicts with template parameter %q", domain.ErrInvalid, parameter.Environment, parameter.Key)
		}
		values[parameter.Key] = normalized
		environment[parameter.Environment] = rendered
	}
	return values, environment, nil
}

func templateParameterValidationValues(parameters []TemplateParameter) map[string]any {
	result := make(map[string]any, len(parameters))
	for _, parameter := range parameters {
		if parameter.Default != nil {
			result[parameter.Key] = parameter.Default
			continue
		}
		switch parameter.Type {
		case "number":
			value := float64(0)
			if parameter.Min != nil {
				value = *parameter.Min
			} else if parameter.Max != nil && value > *parameter.Max {
				value = *parameter.Max
			}
			result[parameter.Key] = value
		case "boolean":
			result[parameter.Key] = false
		case "select":
			result[parameter.Key] = parameter.Options[0].Value
		default:
			result[parameter.Key] = "dbmock-validation"
		}
	}
	return result
}

func templateParameterPlacementEnvironment(parameters []TemplateParameter) map[string]string {
	result := make(map[string]string, len(parameters))
	for index, parameter := range parameters {
		result[parameter.Environment] = fmt.Sprintf("dbmock-parameter-placement-%d-%s", index+1, parameter.Key)
	}
	return result
}

func normalizeTemplateParameterValue(parameter TemplateParameter, value any) (any, string, error) {
	switch parameter.Type {
	case "text", "select":
		text, ok := value.(string)
		if !ok || !utf8.ValidString(text) || strings.ContainsRune(text, '\x00') || len([]rune(text)) > 4096 {
			return nil, "", fmt.Errorf("%w: template parameter %q must be text with at most 4096 characters", domain.ErrInvalid, parameter.Key)
		}
		if parameter.Type == "select" {
			valid := false
			for _, option := range parameter.Options {
				if option.Value == text {
					valid = true
					break
				}
			}
			if !valid {
				return nil, "", fmt.Errorf("%w: template parameter %q is not one of its declared options", domain.ErrInvalid, parameter.Key)
			}
		}
		return text, text, nil
	case "number":
		number, ok := numericValue(value)
		if !ok || !finite(number) || parameter.Min != nil && number < *parameter.Min || parameter.Max != nil && number > *parameter.Max {
			return nil, "", fmt.Errorf("%w: template parameter %q is outside its numeric range", domain.ErrInvalid, parameter.Key)
		}
		return number, strconv.FormatFloat(number, 'f', -1, 64), nil
	case "boolean":
		boolean, ok := value.(bool)
		if !ok {
			return nil, "", fmt.Errorf("%w: template parameter %q must be true or false", domain.ErrInvalid, parameter.Key)
		}
		return boolean, strconv.FormatBool(boolean), nil
	default:
		return nil, "", fmt.Errorf("%w: template parameter %q has unsupported type", domain.ErrInvalid, parameter.Key)
	}
}

func numericValue(value any) (float64, bool) {
	switch number := value.(type) {
	case int:
		return float64(number), true
	case int8:
		return float64(number), true
	case int16:
		return float64(number), true
	case int32:
		return float64(number), true
	case int64:
		return float64(number), true
	case uint:
		return float64(number), true
	case uint8:
		return float64(number), true
	case uint16:
		return float64(number), true
	case uint32:
		return float64(number), true
	case uint64:
		return float64(number), true
	case float32:
		return float64(number), true
	case float64:
		return number, true
	case json.Number:
		parsed, err := number.Float64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }
