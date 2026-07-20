ALTER TABLE template_versions
    ADD COLUMN IF NOT EXISTS risk_report jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE templates
SET risk_report = '[]'::jsonb
WHERE risk_report = 'null'::jsonb;

UPDATE template_versions
SET risk_report = '[]'::jsonb
WHERE risk_report = 'null'::jsonb;

UPDATE template_versions AS version
SET risk_report = template.risk_report
FROM templates AS template
WHERE version.template_id = template.id
  AND version.risk_report = '[]'::jsonb
  AND template.risk_report <> '[]'::jsonb;
