import { ClockCircleOutlined, DeleteOutlined, ReloadOutlined, SafetyCertificateOutlined, SaveOutlined } from '@ant-design/icons'
import { Alert, App, Button, Descriptions, Input, Modal, Space, Spin, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import { api, errorMessage } from '../lib/api'
import { formatDateTime, translateCode } from '../lib/localization'
import { useTaskNotification } from '../lib/task-notification'
import type { InstanceCleanupReview, Task } from '../lib/types'
import { InstanceLifecycleTag } from './InstanceLifecycle'
import { StatusTag } from './Common'

interface InstanceCleanupReviewProps {
  instanceId: string
  instanceName: string
  open: boolean
  onClose: () => void
  onChanged?: () => void | Promise<void>
  onDeleteQueued?: () => void | Promise<void>
}

export function InstanceCleanupReviewModal({
  instanceId,
  instanceName,
  open,
  onClose,
  onChanged,
  onDeleteQueued,
}: InstanceCleanupReviewProps) {
  const { t, i18n } = useTranslation()
  const { timezone } = useSystemSettings()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const notifyTask = useTaskNotification()
  const [review, setReview] = useState<InstanceCleanupReview>()
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [savingDecision, setSavingDecision] = useState('')
  const [deleteStep, setDeleteStep] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState('')
  const [deleteSubmitting, setDeleteSubmitting] = useState(false)

  const loadReview = useCallback(async () => {
    try {
      setLoading(true)
      setLoadError('')
      setReview(await api<InstanceCleanupReview>(`/instances/${instanceId}/cleanup-review`))
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [instanceId])

  useEffect(() => {
    if (!open) return
    setReview(undefined)
    setLoadError('')
    setActionError('')
    setSavingDecision('')
    setDeleteStep(false)
    setDeleteConfirm('')
    setDeleteSubmitting(false)
    void loadReview()
  }, [loadReview, open])

  const mutating = !!savingDecision || deleteSubmitting
  const close = () => {
    if (!mutating) onClose()
  }
  const applyDecision = async (decision: 'extend' | 'retain') => {
    try {
      setSavingDecision(decision)
      setActionError('')
      await api(`/instances/${instanceId}/cleanup-decision`, {
        method: 'POST',
        body: { decision, days: decision === 'extend' ? 7 : 0 },
      })
      message.success(t(decision === 'extend' ? 'cleanupExtendedSuccess' : 'cleanupRetainedSuccess'))
      onClose()
      await onChanged?.()
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      setSavingDecision('')
    }
  }
  const queueDelete = async () => {
    if (!review || deleteConfirm !== review.instanceName) return
    try {
      setDeleteSubmitting(true)
      setActionError('')
      const task = await api<Task>(`/instances/${instanceId}/actions/delete`, {
        method: 'POST',
        body: { confirmName: deleteConfirm },
      })
      notifyTask(task)
      message.success(t('cleanupDeleteQueued'))
      onClose()
      if (onDeleteQueued) await onDeleteQueued()
      else await onChanged?.()
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      setDeleteSubmitting(false)
    }
  }
  const goTo = (path: string) => {
    onClose()
    navigate(path)
  }

  const titleName = review?.instanceName || instanceName
  const footer = deleteStep
    ? <div className="cleanup-review-footer">
      <Button disabled={deleteSubmitting} onClick={() => { setDeleteStep(false); setDeleteConfirm(''); setActionError('') }}>{t('backToCleanupReview')}</Button>
      <Button danger type="primary" icon={<DeleteOutlined />} loading={deleteSubmitting} disabled={!review || deleteConfirm !== review.instanceName} onClick={() => void queueDelete()}>{t('queuePermanentDelete')}</Button>
    </div>
    : <div className="cleanup-review-footer">
      <Button disabled={mutating} onClick={close}>{t('cancel')}</Button>
      <Space wrap className="cleanup-review-decision-actions">
        <Button icon={<SaveOutlined />} loading={savingDecision === 'retain'} disabled={loading || mutating || !review?.expiresAt || review.status === 'deleting'} onClick={() => void applyDecision('retain')}>{t('retainIndefinitely')}</Button>
        <Button icon={<ClockCircleOutlined />} loading={savingDecision === 'extend'} disabled={loading || mutating || !review || review.status === 'deleting'} onClick={() => void applyDecision('extend')}>{t('extendSevenDays')}</Button>
        <Button danger icon={<SafetyCertificateOutlined />} disabled={loading || mutating || !review?.deleteReady} onClick={() => { setDeleteStep(true); setActionError('') }}>{t('continuePermanentDelete')}</Button>
      </Space>
    </div>

  return <Modal
    title={deleteStep ? `${t('permanentDeleteReview')} · ${titleName}` : `${t('reviewCleanup')} · ${titleName}`}
    open={open}
    onCancel={close}
    footer={footer}
    width={760}
    closable={!mutating}
    maskClosable={!mutating}
    destroyOnHidden
  >
    {deleteStep && review
      ? <div className="cleanup-delete-confirm">
        <Alert type="error" showIcon message={t('deleteInstanceWarningTitle')} description={t('deleteInstanceWarningDescription')} />
        <Alert type="warning" showIcon message={t('cleanupDeleteReadyTitle')} description={t('cleanupDeleteReadyHint')} />
        <Typography.Paragraph>{t('deleteInstanceConfirmHint', { name: review.instanceName })}</Typography.Paragraph>
        <Input
          autoFocus
          aria-label={t('deleteInstanceConfirmLabel', { name: review.instanceName })}
          value={deleteConfirm}
          onChange={(event) => setDeleteConfirm(event.target.value)}
          placeholder={review.instanceName}
        />
        {actionError && <Alert type="error" showIcon message={t('cleanupActionFailed')} description={actionError} />}
      </div>
      : <div className="cleanup-review">
        <Typography.Paragraph type="secondary">{t('cleanupReviewHint')}</Typography.Paragraph>
        {loading && !review && <div className="cleanup-review-loading"><Spin /><Typography.Text type="secondary">{t('checkingCleanupReadiness')}</Typography.Text></div>}
        {loadError && <Alert type="error" showIcon message={t('cleanupReviewLoadFailed')} description={loadError} action={<Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void loadReview()}>{t('retry')}</Button>} />}
        {review && <>
          <Descriptions size="small" bordered column={{ xs: 1, sm: 2 }} items={[
            { key: 'purpose', label: t('purpose'), children: review.purpose || t('purposeMissing'), span: 2 },
            { key: 'owner', label: t('owner'), children: review.owner || t('ownerMissing') },
            { key: 'status', label: t('status'), children: <StatusTag value={review.status} /> },
            { key: 'expiry', label: t('expectedExpiry'), children: review.expiresAt ? <Space wrap><InstanceLifecycleTag expiresAt={review.expiresAt} /><span>{formatDateTime(review.expiresAt, i18n.language, timezone)}</span></Space> : t('retainIndefinitely'), span: 2 },
            { key: 'backups', label: t('backups'), children: t('cleanupBackupCount', { count: review.backupCount }) },
            { key: 'operation', label: t('activeOperation'), children: review.activeTask ? <Space wrap><StatusTag value={review.activeTask.status} /><span>{translateCode(t, review.activeTask.kind, 'taskKind')}</span></Space> : t('noActiveOperation') },
          ]} />
          {review.deleteReady
            ? <Alert type="success" showIcon message={t('cleanupReadyTitle')} description={t('cleanupReadyHint')} />
            : <Alert
              type="warning"
              showIcon
              message={t('cleanupBlockedTitle')}
              description={<div className="cleanup-blockers">
                <ul>
                  {review.blockers.includes('active_operation') && <li>{t('cleanupActiveTaskBlocker', { task: review.activeTask ? translateCode(t, review.activeTask.kind, 'taskKind') : t('activeOperation') })}</li>}
                  {review.blockers.includes('backups_present') && <li>{t('cleanupBackupBlocker', { count: review.backupCount })}</li>}
                  {review.blockers.includes('status_not_deletable') && <li>{t('cleanupStatusBlocker', { status: translateCode(t, review.status) })}</li>}
                </ul>
                <Space wrap>
                  {review.blockers.includes('backups_present') && <Button size="small" onClick={() => goTo(`/instances/${review.instanceId}?tab=backups&cleanup=review`)}>{t('reviewBackups')}</Button>}
                  {review.activeTask && <Button size="small" onClick={() => goTo(`/tasks?task=${review.activeTask!.id}`)}>{t('viewTask')}</Button>}
                  <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void loadReview()}>{t('refreshStatus')}</Button>
                </Space>
              </div>}
            />}
        </>}
        {actionError && <Alert type="error" showIcon message={t('cleanupActionFailed')} description={actionError} />}
      </div>}
  </Modal>
}
