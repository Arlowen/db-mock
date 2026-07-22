package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pika/db-mock/internal/domain"
)

type TemplateInput struct {
	Slug        string
	Name        string
	NameZH      string
	Description string
	Category    string
	Tier        string
	Builtin     bool
	Icon        string
	RiskReport  json.RawMessage
}

type TemplateVersionInput struct {
	Version         string
	ImageReference  string
	Architectures   []string
	MinCPU          float64
	MinMemoryBytes  int64
	MinDiskBytes    int64
	DefaultPort     int
	ComposeTemplate string
	Manifest        json.RawMessage
	RiskReport      json.RawMessage
	PackagePath     string
}

func normalizeTemplateInput(input *TemplateInput, version *TemplateVersionInput) {
	if len(version.RiskReport) == 0 && len(input.RiskReport) > 0 {
		version.RiskReport = input.RiskReport
	}
	if len(input.RiskReport) == 0 {
		input.RiskReport = json.RawMessage(`[]`)
	}
	if len(version.Manifest) == 0 {
		version.Manifest = json.RawMessage(`{}`)
	}
	if len(version.RiskReport) == 0 {
		version.RiskReport = json.RawMessage(`[]`)
	}
	if len(version.Architectures) == 0 {
		version.Architectures = []string{"amd64"}
	}
}

// UpsertBuiltinTemplate synchronizes built-in catalog metadata while preserving
// the first stored definition of every version. Changing a built-in version's
// deployment contract requires publishing a new version identifier.
func (s *Store) UpsertBuiltinTemplate(ctx context.Context, input TemplateInput, version TemplateVersionInput) (domain.Template, error) {
	normalizeTemplateInput(&input, &version)
	input.Builtin = true
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Template{}, err
	}
	defer tx.Rollback(ctx)
	var item domain.Template
	err = tx.QueryRow(ctx, `INSERT INTO templates(id,slug,name,name_zh,description,category,tier,builtin,icon,risk_report)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(slug) DO UPDATE SET name=excluded.name,name_zh=excluded.name_zh,
        description=excluded.description,category=excluded.category,tier=excluded.tier,
        icon=excluded.icon,risk_report=excluded.risk_report,updated_at=now()
        WHERE templates.builtin
        RETURNING id,slug,name,name_zh,description,category,tier,builtin,icon,risk_report,created_at,updated_at`,
		uuid.New(), input.Slug, input.Name, input.NameZH, input.Description, input.Category, input.Tier,
		input.Builtin, input.Icon, input.RiskReport).Scan(&item.ID, &item.Slug, &item.Name, &item.NameZH,
		&item.Description, &item.Category, &item.Tier, &item.Builtin, &item.Icon, &item.RiskReport,
		&item.CreatedAt, &item.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Template{}, fmt.Errorf("%w: built-in template slug %q is already used by a custom template", domain.ErrConflict, input.Slug)
	}
	if err != nil {
		return domain.Template{}, err
	}
	var v domain.TemplateVersion
	err = tx.QueryRow(ctx, `INSERT INTO template_versions(id,template_id,version,image_reference,architectures,
		min_cpu,min_memory_bytes,min_disk_bytes,default_port,compose_template,manifest,risk_report,package_path,selectable,immutable)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,true)
		ON CONFLICT(template_id,version) DO NOTHING
		RETURNING id,template_id,version,image_reference,architectures,min_cpu,min_memory_bytes,min_disk_bytes,
		default_port,compose_template,manifest,risk_report,package_path,selectable,immutable,created_at`, uuid.New(), item.ID,
		version.Version, version.ImageReference, version.Architectures, version.MinCPU, version.MinMemoryBytes,
		version.MinDiskBytes, version.DefaultPort, version.ComposeTemplate, version.Manifest, version.RiskReport,
		version.PackagePath).Scan(templateVersionScan(&v)...)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `SELECT id,template_id,version,image_reference,architectures,min_cpu,min_memory_bytes,
			min_disk_bytes,default_port,compose_template,manifest,risk_report,package_path,selectable,immutable,created_at
            FROM template_versions WHERE template_id=$1 AND version=$2`, item.ID, version.Version).Scan(templateVersionScan(&v)...)
	}
	if err != nil {
		return domain.Template{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Template{}, err
	}
	item.Versions = []domain.TemplateVersion{v}
	return item, nil
}

// CreateCustomTemplateVersion creates a new immutable custom template version.
// Re-uploading an existing slug and version is deliberately rejected so an
// instance pinned to that version can never observe a different Compose file.
func (s *Store) CreateCustomTemplateVersion(ctx context.Context, input TemplateInput, version TemplateVersionInput) (domain.Template, error) {
	normalizeTemplateInput(&input, &version)
	input.Builtin = false
	input.Tier = "custom"
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Template{}, err
	}
	defer tx.Rollback(ctx)

	var item domain.Template
	err = tx.QueryRow(ctx, `INSERT INTO templates(id,slug,name,name_zh,description,category,tier,builtin,icon,risk_report)
        VALUES($1,$2,$3,$4,$5,$6,$7,false,$8,$9)
        ON CONFLICT(slug) DO UPDATE SET name=excluded.name,name_zh=excluded.name_zh,
        description=excluded.description,category=excluded.category,tier='custom',
        icon=excluded.icon,risk_report=excluded.risk_report,updated_at=now()
        WHERE NOT templates.builtin
        RETURNING id,slug,name,name_zh,description,category,tier,builtin,icon,risk_report,created_at,updated_at`,
		uuid.New(), input.Slug, input.Name, input.NameZH, input.Description, input.Category,
		input.Tier, input.Icon, input.RiskReport).Scan(&item.ID, &item.Slug, &item.Name, &item.NameZH,
		&item.Description, &item.Category, &item.Tier, &item.Builtin, &item.Icon, &item.RiskReport,
		&item.CreatedAt, &item.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Template{}, fmt.Errorf("%w: template slug is reserved by a built-in template", domain.ErrConflict)
	}
	if err != nil {
		return domain.Template{}, err
	}

	var v domain.TemplateVersion
	err = tx.QueryRow(ctx, `INSERT INTO template_versions(id,template_id,version,image_reference,architectures,
		min_cpu,min_memory_bytes,min_disk_bytes,default_port,compose_template,manifest,risk_report,package_path,selectable,immutable)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,true)
		RETURNING id,template_id,version,image_reference,architectures,min_cpu,min_memory_bytes,min_disk_bytes,
		default_port,compose_template,manifest,risk_report,package_path,selectable,immutable,created_at`, uuid.New(), item.ID,
		version.Version, version.ImageReference, version.Architectures, version.MinCPU, version.MinMemoryBytes,
		version.MinDiskBytes, version.DefaultPort, version.ComposeTemplate, version.Manifest, version.RiskReport,
		version.PackagePath).Scan(templateVersionScan(&v)...)
	if errors.Is(translate(err), domain.ErrConflict) {
		return domain.Template{}, fmt.Errorf("%w: template version already exists and cannot be replaced", domain.ErrConflict)
	}
	if err != nil {
		return domain.Template{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.Template{}, err
	}
	item.Versions = []domain.TemplateVersion{v}
	return item, nil
}

func templateVersionScan(v *domain.TemplateVersion) []any {
	return []any{&v.ID, &v.TemplateID, &v.Version, &v.ImageReference, &v.Architectures, &v.MinCPU,
		&v.MinMemoryBytes, &v.MinDiskBytes, &v.DefaultPort, &v.ComposeTemplate, &v.Manifest, &v.RiskReport, &v.PackagePath,
		&v.Selectable, &v.Immutable, &v.CreatedAt}
}

func (s *Store) GetTemplateVersion(ctx context.Context, id uuid.UUID) (domain.Template, domain.TemplateVersion, error) {
	var item domain.Template
	var version domain.TemplateVersion
	scanArgs := []any{&item.ID, &item.Slug, &item.Name, &item.NameZH, &item.Description, &item.Category, &item.Tier,
		&item.Builtin, &item.Icon, &item.RiskReport, &item.CreatedAt, &item.UpdatedAt}
	scanArgs = append(scanArgs, templateVersionScan(&version)...)
	err := s.pool.QueryRow(ctx, `SELECT t.id,t.slug,t.name,t.name_zh,t.description,t.category,t.tier,t.builtin,t.icon,
		t.risk_report,t.created_at,t.updated_at,v.id,v.template_id,v.version,v.image_reference,v.architectures,
		v.min_cpu,v.min_memory_bytes,v.min_disk_bytes,v.default_port,v.compose_template,v.manifest,v.risk_report,v.package_path,
		v.selectable,v.immutable,v.created_at FROM template_versions v JOIN templates t ON t.id=v.template_id WHERE v.id=$1`, id).Scan(
		scanArgs...)
	return item, version, translate(err)
}

func (s *Store) ListTemplates(ctx context.Context) ([]domain.Template, error) {
	rows, err := s.pool.Query(ctx, `SELECT t.id,t.slug,t.name,t.name_zh,t.description,t.category,t.tier,t.builtin,t.icon,
		t.risk_report,t.created_at,t.updated_at,v.id,v.template_id,v.version,v.image_reference,v.architectures,
		v.min_cpu,v.min_memory_bytes,v.min_disk_bytes,v.default_port,v.manifest,v.risk_report,v.selectable,v.immutable,v.created_at
        FROM templates t LEFT JOIN template_versions v ON v.template_id=t.id
        ORDER BY CASE t.tier WHEN 'standard' THEN 1 WHEN 'experimental' THEN 2 ELSE 3 END,lower(t.name),v.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.Template, 0)
	index := make(map[uuid.UUID]int)
	for rows.Next() {
		var item domain.Template
		var version domain.TemplateVersion
		if err := rows.Scan(&item.ID, &item.Slug, &item.Name, &item.NameZH, &item.Description,
			&item.Category, &item.Tier, &item.Builtin, &item.Icon, &item.RiskReport, &item.CreatedAt,
			&item.UpdatedAt, &version.ID, &version.TemplateID, &version.Version, &version.ImageReference,
			&version.Architectures, &version.MinCPU, &version.MinMemoryBytes, &version.MinDiskBytes,
			&version.DefaultPort, &version.Manifest, &version.RiskReport, &version.Selectable, &version.Immutable, &version.CreatedAt); err != nil {
			return nil, err
		}
		position, ok := index[item.ID]
		if !ok {
			position = len(items)
			index[item.ID] = position
			item.Versions = make([]domain.TemplateVersion, 0)
			items = append(items, item)
		}
		if version.ID != uuid.Nil {
			items[position].Versions = append(items[position].Versions, version)
		}
	}
	return items, rows.Err()
}

type DeletedTemplate struct {
	Name         string
	PackagePaths []string
}

func (s *Store) DeleteTemplate(ctx context.Context, id uuid.UUID) (DeletedTemplate, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return DeletedTemplate{}, err
	}
	defer tx.Rollback(ctx)
	var deleted DeletedTemplate
	var builtin bool
	if err = tx.QueryRow(ctx, "SELECT name,builtin FROM templates WHERE id=$1 FOR UPDATE", id).Scan(&deleted.Name, &builtin); err != nil {
		return DeletedTemplate{}, translate(err)
	}
	if builtin {
		return DeletedTemplate{}, domain.ErrForbidden
	}
	rows, err := tx.Query(ctx, `SELECT package_path FROM template_versions
        WHERE template_id=$1 ORDER BY created_at FOR UPDATE`, id)
	if err != nil {
		return DeletedTemplate{}, err
	}
	for rows.Next() {
		var packagePath string
		if err = rows.Scan(&packagePath); err != nil {
			rows.Close()
			return DeletedTemplate{}, err
		}
		if packagePath != "" {
			deleted.PackagePaths = append(deleted.PackagePaths, packagePath)
		}
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return DeletedTemplate{}, err
	}
	rows.Close()
	var count int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM instances i JOIN template_versions v ON v.id=i.template_version_id
		WHERE v.template_id=$1`, id).Scan(&count); err != nil {
		return DeletedTemplate{}, err
	}
	if count > 0 {
		return DeletedTemplate{}, fmt.Errorf("%w: template is referenced by database instance history", domain.ErrConflict)
	}
	if _, err := tx.Exec(ctx, "DELETE FROM template_versions WHERE template_id=$1", id); err != nil {
		return DeletedTemplate{}, err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM templates WHERE id=$1", id); err != nil {
		return DeletedTemplate{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return DeletedTemplate{}, err
	}
	return deleted, nil
}

func NormalizeTemplateSlug(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var b strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		} else if b.Len() > 0 && !strings.HasSuffix(b.String(), "-") {
			b.WriteByte('-')
		}
	}
	return strings.Trim(b.String(), "-")
}
