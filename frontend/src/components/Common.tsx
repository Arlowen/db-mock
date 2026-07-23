import { Button, Empty, Space, Tag, Typography } from 'antd'
import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

const PageHeaderTargetContext = createContext<HTMLElement | null | undefined>(undefined)

const colors: Record<string, string> = {
  online: 'green', running: 'green', succeeded: 'green', standard: 'blue',
  pending: 'gold', queued: 'gold', retrying: 'gold', sending: 'processing', provisioning: 'processing', starting: 'processing', stopping: 'processing', restarting: 'processing', upgrading: 'processing', reconfiguring: 'processing', backing_up: 'processing', restoring: 'processing', creating: 'processing', ready: 'success', deleting: 'processing', experimental: 'orange',
  failed: 'red', offline: 'red', critical: 'red', degraded: 'orange', needs_docker: 'purple',
  stopped: 'default', canceled: 'default', disabled: 'default', custom: 'cyan', info: 'blue', delivered: 'green', enabled: 'green', warning: 'orange', acknowledged: 'blue', resolved: 'green',
}

export function StatusTag({ value }: { value: string }) {
  const { t } = useTranslation()
  return <Tag color={colors[value] ?? 'default'}>{t(value, { defaultValue: value.replaceAll('_', ' ') })}</Tag>
}

export function PageHeaderTargetProvider({ target, children }: { target: HTMLElement | null; children: ReactNode }) {
  return <PageHeaderTargetContext.Provider value={target}>{children}</PageHeaderTargetContext.Provider>
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  const target = useContext(PageHeaderTargetContext)
  const header = <div className="page-header"><div className="page-header-copy"><Typography.Title level={2}>{title}</Typography.Title>{description && <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>}</div>{actions && <Space className="page-header-actions" wrap>{actions}</Space>}</div>
  if (target === undefined) return header
  return target ? createPortal(header, target) : null
}

export function EmptyState({ action, actionLabel, description, compact = false }: { action?: () => void; actionLabel?: ReactNode; description?: ReactNode; compact?: boolean }) {
  const { t } = useTranslation()
  return <Empty className={compact ? 'compact-empty' : undefined} image={compact ? Empty.PRESENTED_IMAGE_SIMPLE : undefined} description={description ?? t('noData')}>{action && <Button type="primary" onClick={action}>{actionLabel ?? t('create')}</Button>}</Empty>
}
