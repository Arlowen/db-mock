import { Button, Empty, Space, Tag, Typography } from 'antd'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

const colors: Record<string, string> = {
  online: 'green', running: 'green', succeeded: 'green', standard: 'blue',
  pending: 'gold', queued: 'gold', retrying: 'gold', sending: 'processing', provisioning: 'processing', starting: 'processing', stopping: 'processing', restarting: 'processing', upgrading: 'processing', backing_up: 'processing', restoring: 'processing', creating: 'processing', ready: 'success', deleting: 'processing', experimental: 'orange',
  failed: 'red', offline: 'red', critical: 'red', degraded: 'orange', needs_docker: 'purple',
  stopped: 'default', canceled: 'default', disabled: 'default', custom: 'cyan', info: 'blue', delivered: 'green', enabled: 'green', warning: 'orange', acknowledged: 'blue', resolved: 'green',
}

export function StatusTag({ value }: { value: string }) {
  const { t } = useTranslation()
  return <Tag color={colors[value] ?? 'default'}>{t(value, { defaultValue: value.replaceAll('_', ' ') })}</Tag>
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return <div className="page-header"><div><Typography.Title level={2}>{title}</Typography.Title>{description && <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>}</div>{actions && <Space wrap>{actions}</Space>}</div>
}

export function EmptyState({ action, actionLabel, description, compact = false }: { action?: () => void; actionLabel?: ReactNode; description?: ReactNode; compact?: boolean }) {
  const { t } = useTranslation()
  return <Empty className={compact ? 'compact-empty' : undefined} image={compact ? Empty.PRESENTED_IMAGE_SIMPLE : undefined} description={description ?? t('noData')}>{action && <Button type="primary" onClick={action}>{actionLabel ?? t('create')}</Button>}</Empty>
}
