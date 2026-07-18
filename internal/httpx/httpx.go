package httpx

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"runtime/debug"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/auth"
	"github.com/pika/db-mock/internal/domain"
)

type ErrorBody struct {
	Error     ErrorDetail `json:"error"`
	RequestID string      `json:"requestId,omitempty"`
}
type ErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details any    `json:"details,omitempty"`
}

func JSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if status != http.StatusNoContent {
		_ = json.NewEncoder(w).Encode(value)
	}
}

func Decode(r *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 2*1024*1024+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("%w: %v", domain.ErrInvalid, err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("%w: request body must contain one JSON value", domain.ErrInvalid)
	}
	return nil
}

func Error(w http.ResponseWriter, r *http.Request, err error) {
	status := http.StatusInternalServerError
	code := "internal_error"
	message := "Internal server error"
	switch {
	case errors.Is(err, domain.ErrNotFound):
		status = http.StatusNotFound
		code = "not_found"
		message = "Resource not found"
	case errors.Is(err, domain.ErrConflict):
		status = http.StatusConflict
		code = "resource_conflict"
		message = err.Error()
	case errors.Is(err, domain.ErrUnauthorized):
		status = http.StatusUnauthorized
		code = "unauthorized"
		message = "Authentication required"
	case errors.Is(err, domain.ErrForbidden):
		status = http.StatusForbidden
		code = "forbidden"
		message = "Operation forbidden"
	case errors.Is(err, domain.ErrInvalid):
		status = http.StatusBadRequest
		code = "invalid_input"
		message = err.Error()
	case errors.Is(err, domain.ErrNotConfigured):
		status = http.StatusPreconditionFailed
		code = "not_initialized"
		message = "Platform is not initialized"
	case errors.Is(err, domain.ErrUnavailable):
		status = http.StatusServiceUnavailable
		code = "resource_unavailable"
		message = err.Error()
	}
	JSON(w, status, ErrorBody{Error: ErrorDetail{Code: code, Message: message}, RequestID: auth.RequestID(r.Context())})
}

func UUIDParam(value string) (uuid.UUID, error) {
	id, err := uuid.Parse(value)
	if err != nil {
		return uuid.Nil, domain.ErrInvalid
	}
	return id, nil
}

type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}
func (w *statusWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(data)
	w.bytes += n
	return n, err
}

func RequestMiddleware(logger *slog.Logger, publicURL string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requestID := r.Header.Get("X-Request-ID")
			if requestID == "" {
				requestID = uuid.NewString()
			}
			if strings.HasPrefix(r.URL.Path, "/api/") {
				w.Header().Set("Cache-Control", "no-store")
			}
			w.Header().Set("X-Request-ID", requestID)
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("Referrer-Policy", "same-origin")
			w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
			ctx := auth.WithRequestID(r.Context(), requestID)
			started := time.Now()
			writer := &statusWriter{ResponseWriter: w}
			defer func() {
				if recovered := recover(); recovered != nil {
					logger.Error("panic", "requestId", requestID, "error", recovered, "stack", string(debug.Stack()))
					if writer.status == 0 {
						Error(writer, r, errors.New("panic"))
					}
				}
				logger.Info("request", "requestId", requestID, "method", r.Method, "path", r.URL.Path, "status", writer.status, "duration", time.Since(started), "bytes", writer.bytes)
			}()
			if isMutation(r.Method) && !sameOrigin(r, publicURL) {
				Error(writer, r, domain.ErrForbidden)
				return
			}
			next.ServeHTTP(writer, r.WithContext(ctx))
		})
	}
}

func isMutation(method string) bool {
	return method != "GET" && method != "HEAD" && method != "OPTIONS"
}
func sameOrigin(r *http.Request, publicURL string) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err == nil && strings.EqualFold(parsed.Host, r.Host) {
		return true
	}
	return strings.EqualFold(strings.TrimRight(origin, "/"), strings.TrimRight(publicURL, "/"))
}
