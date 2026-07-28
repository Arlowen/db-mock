package tasks

import "errors"

type failureResultError struct {
	err    error
	result any
}

func (e *failureResultError) Error() string { return e.err.Error() }
func (e *failureResultError) Unwrap() error { return e.err }
func (e *failureResultError) FailureResult() any {
	return e.result
}

// WithFailureResult attaches non-sensitive recovery facts that must remain
// available after a task fails. The original error still drives task status,
// failure classification, and retry behavior.
func WithFailureResult(err error, result any) error {
	if err == nil {
		return nil
	}
	return &failureResultError{err: err, result: result}
}

func failureResult(err error) any {
	var provider interface{ FailureResult() any }
	if errors.As(err, &provider) {
		return provider.FailureResult()
	}
	return nil
}
