package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pika/db-mock/internal/domain"
)

func (s *Store) CreateUser(ctx context.Context, username, displayName, locale, passwordHash string) (domain.User, error) {
	username = strings.TrimSpace(username)
	if username == "" || passwordHash == "" {
		return domain.User{}, domain.ErrInvalid
	}
	if locale != "en-US" {
		locale = "zh-CN"
	}
	if displayName == "" {
		displayName = username
	}
	user := domain.User{ID: uuid.New(), Username: username, DisplayName: displayName, Locale: locale}
	err := s.pool.QueryRow(ctx, `INSERT INTO users(id,username,display_name,locale,password_hash)
        VALUES($1,$2,$3,$4,$5) RETURNING created_at,updated_at`, user.ID, user.Username,
		user.DisplayName, user.Locale, passwordHash).Scan(&user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		if strings.Contains(err.Error(), "users_username_lower_idx") {
			return domain.User{}, domain.ErrConflict
		}
		return domain.User{}, err
	}
	return user, nil
}

// CreateInitialUser serializes platform initialization so two concurrent setup requests cannot
// both create an all-powerful first account.
func (s *Store) CreateInitialUser(ctx context.Context, username, displayName, locale, passwordHash string) (domain.User, error) {
	username = strings.TrimSpace(username)
	if username == "" || passwordHash == "" {
		return domain.User{}, domain.ErrInvalid
	}
	if locale != "en-US" {
		locale = "zh-CN"
	}
	if displayName == "" {
		displayName = username
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return domain.User{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", int64(0x44424d4f434b)); err != nil {
		return domain.User{}, err
	}
	var initialized bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users)").Scan(&initialized); err != nil {
		return domain.User{}, err
	}
	if initialized {
		return domain.User{}, domain.ErrConflict
	}
	user := domain.User{ID: uuid.New(), Username: username, DisplayName: displayName, Locale: locale}
	err = tx.QueryRow(ctx, `INSERT INTO users(id,username,display_name,locale,password_hash)
        VALUES($1,$2,$3,$4,$5) RETURNING created_at,updated_at`, user.ID, user.Username,
		user.DisplayName, user.Locale, passwordHash).Scan(&user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return domain.User{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.User{}, err
	}
	return user, nil
}

func (s *Store) FindUserByUsername(ctx context.Context, username string) (domain.User, error) {
	var user domain.User
	err := s.pool.QueryRow(ctx, `SELECT id,username,display_name,locale,password_hash,disabled_at,last_login_at,
        created_at,updated_at FROM users WHERE lower(username)=lower($1)`, strings.TrimSpace(username)).Scan(
		&user.ID, &user.Username, &user.DisplayName, &user.Locale, &user.PasswordHash, &user.DisabledAt,
		&user.LastLoginAt, &user.CreatedAt, &user.UpdatedAt)
	return user, translate(err)
}

func (s *Store) GetUser(ctx context.Context, id uuid.UUID) (domain.User, error) {
	var user domain.User
	err := s.pool.QueryRow(ctx, `SELECT id,username,display_name,locale,password_hash,disabled_at,last_login_at,
        created_at,updated_at FROM users WHERE id=$1`, id).Scan(&user.ID, &user.Username, &user.DisplayName,
		&user.Locale, &user.PasswordHash, &user.DisabledAt, &user.LastLoginAt, &user.CreatedAt, &user.UpdatedAt)
	return user, translate(err)
}

func (s *Store) ListUsers(ctx context.Context) ([]domain.User, error) {
	rows, err := s.pool.Query(ctx, `SELECT id,username,display_name,locale,password_hash,disabled_at,last_login_at,
        created_at,updated_at FROM users ORDER BY lower(username)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.User, 0)
	for rows.Next() {
		var user domain.User
		if err := rows.Scan(&user.ID, &user.Username, &user.DisplayName, &user.Locale, &user.PasswordHash,
			&user.DisabledAt, &user.LastLoginAt, &user.CreatedAt, &user.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, user)
	}
	return items, rows.Err()
}

func (s *Store) UpdateUser(ctx context.Context, id uuid.UUID, displayName, locale string, disabled *bool, passwordHash string, keepSessionID *uuid.UUID) (domain.User, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.User{}, err
	}
	defer tx.Rollback(ctx)
	if disabled != nil && *disabled {
		var active int
		if err := tx.QueryRow(ctx, "SELECT count(*) FROM users WHERE disabled_at IS NULL AND id<>$1", id).Scan(&active); err != nil {
			return domain.User{}, err
		}
		if active == 0 {
			return domain.User{}, domain.ErrConflict
		}
	}
	result, err := tx.Exec(ctx, `UPDATE users SET
        display_name=CASE WHEN $2='' THEN display_name ELSE $2 END,
        locale=CASE WHEN $3 IN ('zh-CN','en-US') THEN $3 ELSE locale END,
        disabled_at=CASE WHEN $4::boolean IS NULL THEN disabled_at WHEN $4 THEN now() ELSE NULL END,
        password_hash=CASE WHEN $5='' THEN password_hash ELSE $5 END,updated_at=now() WHERE id=$1`,
		id, displayName, locale, disabled, passwordHash)
	if err != nil {
		return domain.User{}, err
	}
	if result.RowsAffected() == 0 {
		return domain.User{}, domain.ErrNotFound
	}
	if disabled != nil && *disabled {
		if _, err = tx.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", id); err != nil {
			return domain.User{}, err
		}
	} else if passwordHash != "" {
		if keepSessionID == nil {
			_, err = tx.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1", id)
		} else {
			_, err = tx.Exec(ctx, "DELETE FROM sessions WHERE user_id=$1 AND id<>$2", id, *keepSessionID)
		}
		if err != nil {
			return domain.User{}, err
		}
	}
	var user domain.User
	err = tx.QueryRow(ctx, `SELECT id,username,display_name,locale,password_hash,disabled_at,last_login_at,
        created_at,updated_at FROM users WHERE id=$1`, id).Scan(&user.ID, &user.Username, &user.DisplayName,
		&user.Locale, &user.PasswordHash, &user.DisabledAt, &user.LastLoginAt, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return domain.User{}, translate(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.User{}, err
	}
	return user, nil
}

func (s *Store) CreateSession(ctx context.Context, userID uuid.UUID, duration time.Duration, ip, userAgent string) (string, domain.Session, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", domain.Session{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	hash := sha256.Sum256(raw)
	session := domain.Session{ID: uuid.New(), UserID: userID, TokenHash: hash[:], ExpiresAt: time.Now().Add(duration), IP: ip, UserAgent: userAgent}
	err := s.pool.QueryRow(ctx, `INSERT INTO sessions(id,user_id,token_hash,expires_at,ip,user_agent)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING created_at,last_seen`, session.ID, session.UserID, session.TokenHash,
		session.ExpiresAt, session.IP, session.UserAgent).Scan(&session.CreatedAt, &session.LastSeen)
	if err == nil {
		_, _ = s.pool.Exec(ctx, "UPDATE users SET last_login_at=now(),updated_at=now() WHERE id=$1", userID)
	}
	return token, session, err
}

func (s *Store) ResolveSession(ctx context.Context, token string) (domain.User, domain.Session, error) {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != 32 {
		return domain.User{}, domain.Session{}, domain.ErrUnauthorized
	}
	hash := sha256.Sum256(raw)
	var user domain.User
	var session domain.Session
	err = s.pool.QueryRow(ctx, `SELECT s.id,s.user_id,s.token_hash,s.expires_at,s.created_at,s.last_seen,s.ip,s.user_agent,
        u.id,u.username,u.display_name,u.locale,u.password_hash,u.disabled_at,u.last_login_at,u.created_at,u.updated_at
        FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.expires_at>now() AND u.disabled_at IS NULL`, hash[:]).Scan(
		&session.ID, &session.UserID, &session.TokenHash, &session.ExpiresAt, &session.CreatedAt, &session.LastSeen,
		&session.IP, &session.UserAgent, &user.ID, &user.Username, &user.DisplayName, &user.Locale,
		&user.PasswordHash, &user.DisabledAt, &user.LastLoginAt, &user.CreatedAt, &user.UpdatedAt)
	if errorsIsNoRows(err) {
		return domain.User{}, domain.Session{}, domain.ErrUnauthorized
	}
	if err == nil && time.Since(session.LastSeen) > 5*time.Minute {
		_, _ = s.pool.Exec(ctx, "UPDATE sessions SET last_seen=now() WHERE id=$1", session.ID)
	}
	return user, session, err
}

func (s *Store) DeleteSession(ctx context.Context, token string) error {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return nil
	}
	hash := sha256.Sum256(raw)
	_, err = s.pool.Exec(ctx, "DELETE FROM sessions WHERE token_hash=$1", hash[:])
	return err
}

func errorsIsNoRows(err error) bool { return err == pgx.ErrNoRows }
