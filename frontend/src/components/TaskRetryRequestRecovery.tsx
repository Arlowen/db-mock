import { ReloadOutlined, RedoOutlined } from '@ant-design/icons'
import { Alert, Button, Space, Tag, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { translateCode } from '../lib/localization'
import type { TaskRetryRequestEvidence, TaskRetryRequestFailure } from '../lib/task-retry-request'
import type { Task } from '../lib/types'
import { StatusTag } from './Common'

interface TaskRetryRequestRecoveryProps {
  className?: string
  evidence: TaskRetryRequestEvidence
  failure: TaskRetryRequestFailure
  onClose: () => void
  onOpenResource?: (task: Task) => void
  onOpenTask: (task: Task) => void
  onRefresh: () => void
  onRetry: (task: Task) => void
  refreshError?: string
  refreshing?: boolean
  showRetry?: boolean
  submittingTaskID?: string
}

export function TaskRetryRequestRecovery({
  className,
  evidence,
  failure,
  onClose,
  onOpenResource,
  onOpenTask,
  onRefresh,
  onRetry,
  refreshError,
  refreshing,
  showRetry = true,
  submittingTaskID,
}: TaskRetryRequestRecoveryProps) {
  const { t } = useTranslation()
  const cause = evidence.phase === 'blocked' && evidence.blocker
    ? t('taskRetryRequestBlockedCause', { operation: translateCode(t, evidence.blocker.kind, 'taskKind') })
    : failure.serverRejected
      ? t(`error_${failure.code}`, { defaultValue: failure.message })
      : failure.message

  return <Alert
    className={`task-retry-request-alert${className ? ` ${className}` : ''}`}
    type={evidence.phase === 'ready' ? 'success' : evidence.phase === 'unavailable' ? 'error' : 'warning'}
    showIcon
    closable
    aria-live="polite"
    title={t(failure.serverRejected ? 'taskRetryRequestRejectedTitle' : 'taskRetryRequestUnknownTitle')}
    description={<div className="task-retry-request-body">
      <div className="task-retry-request-grid">
        <div><Typography.Text type="secondary">{t('failureCause')}</Typography.Text><Typography.Text>{cause}</Typography.Text></div>
        <div><Typography.Text type="secondary">{t('failureImpact')}</Typography.Text><Typography.Text>{t(failure.serverRejected ? 'taskRetryRequestRejectedImpact' : 'taskRetryRequestUnknownImpact')}</Typography.Text></div>
        <div><Typography.Text type="secondary">{t('recoveryAdvice')}</Typography.Text><Typography.Text>{t(`taskRetryRequestRecovery_${evidence.phase}`)}</Typography.Text></div>
      </div>
      <div className="task-retry-request-evidence">
        <Typography.Text type="secondary">{t('taskRetryRequestErrorCode')}</Typography.Text>
        <Tag>{failure.code}</Tag>
      </div>
      {evidence.blocker && <div className="task-retry-request-evidence">
        <Typography.Text type="secondary">{t('taskRetryRequestCurrentTask')}</Typography.Text>
        <StatusTag value={evidence.blocker.status} />
        <Typography.Text strong>{translateCode(t, evidence.blocker.kind, 'taskKind')}</Typography.Text>
        <Typography.Text code>{evidence.blocker.id.slice(0, 8)}</Typography.Text>
      </div>}
      {refreshError && <Typography.Text className="task-retry-request-refresh-error" type="danger">{t('taskRetryEvidenceRefreshFailed', { error: refreshError })}</Typography.Text>}
    </div>}
    action={<Space wrap className="task-retry-request-actions">
      {showRetry && evidence.canRetry && evidence.original && <Button size="small" type="primary" loading={submittingTaskID === evidence.original.id} disabled={Boolean(submittingTaskID && submittingTaskID !== evidence.original.id)} icon={<RedoOutlined />} onClick={() => onRetry(evidence.original!)}>{t('retryTask')}</Button>}
      <Button size="small" loading={refreshing} disabled={Boolean(submittingTaskID)} icon={<ReloadOutlined />} onClick={onRefresh}>{t('refreshTaskEvidence')}</Button>
      {evidence.blocker && <Button size="small" disabled={Boolean(submittingTaskID)} onClick={() => onOpenTask(evidence.blocker!)}>{t('viewCurrentTask')}</Button>}
      {evidence.original && onOpenResource && <Button size="small" disabled={Boolean(submittingTaskID)} onClick={() => onOpenResource(evidence.original!)}>{t('viewResource')}</Button>}
    </Space>}
    onClose={onClose}
  />
}
