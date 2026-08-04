import { DeleteOutlined, ReloadOutlined } from '@ant-design/icons'
import { Alert, App, Button, Input, Modal, Space, Spin, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, api, errorMessage } from '../lib/api'
import { canSubmitInstanceDelete, instanceDeleteEvidence } from '../lib/instance-delete'
import { translateCode } from '../lib/localization'
import { useTaskNotification } from '../lib/task-notification'
import type { InstanceBackup, InstanceCleanupReview, Task } from '../lib/types'
import { bytes } from '../lib/types'
import { StatusTag } from './Common'

interface InstanceDeleteModalProps {
  instanceId: string
  instanceName: string
  open: boolean
  onClose: () => void
  onDeleteQueued: (task: Task) => void | Promise<void>
  onOpenTask: (taskId: string) => void
  onInstanceMissing: () => void
}

interface DeleteRequestFailure {
  code: string
  message: string
}

export function InstanceDeleteModal({
  instanceId,
  instanceName,
  open,
  onClose,
  onDeleteQueued,
  onOpenTask,
  onInstanceMissing,
}: InstanceDeleteModalProps) {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const notifyTask = useTaskNotification()
  const [review, setReview] = useState<InstanceCleanupReview>()
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [requestFailure, setRequestFailure] = useState<DeleteRequestFailure>()
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const [backups, setBackups] = useState<InstanceBackup[]>([])
  const [backupsError, setBackupsError] = useState('')
  const [backupToDelete, setBackupToDelete] = useState<InstanceBackup>()
  const [backupConfirmation, setBackupConfirmation] = useState('')
  const [backupSubmitting, setBackupSubmitting] = useState(false)
  const [backupFailure, setBackupFailure] = useState('')
  const [backupNeedsRefresh, setBackupNeedsRefresh] = useState(false)
  const [queuedBackupTask, setQueuedBackupTask] = useState<Task>()

  const loadReview = useCallback(async ({ clearFailure = false }: { clearFailure?: boolean } = {}) => {
    try {
      setLoading(true)
      setLoadError('')
      const nextReview = await api<InstanceCleanupReview>(`/instances/${instanceId}/cleanup-review`)
      setReview(nextReview)
      setBackupsError('')
      let backupEvidenceReady = true
      if (nextReview.backupCount > 0) {
        try {
          const result = await api<{ items: InstanceBackup[] }>(`/instances/${instanceId}/backups`)
          setBackups(result.items)
        } catch (error) {
          setBackups([])
          setBackupsError(errorMessage(error))
          backupEvidenceReady = false
        }
      } else {
        setBackups([])
      }
      if (clearFailure && backupEvidenceReady) {
        setRequestFailure(undefined)
        setNeedsRefresh(false)
        setConfirmation('')
        setBackupFailure('')
        setBackupNeedsRefresh(false)
        setQueuedBackupTask(undefined)
      }
      return backupEvidenceReady
    } catch (error) {
      if (error instanceof ApiError && error.code === 'not_found') {
        message.success(t('instanceDeleteNoLongerPresent'))
        onInstanceMissing()
        return false
      }
      setLoadError(errorMessage(error))
      return false
    } finally {
      setLoading(false)
    }
  }, [instanceId, message, onInstanceMissing, t])

  useEffect(() => {
    if (!open) return
    setReview(undefined)
    setLoadError('')
    setConfirmation('')
    setSubmitting(false)
    setRequestFailure(undefined)
    setNeedsRefresh(false)
    setBackups([])
    setBackupsError('')
    setBackupToDelete(undefined)
    setBackupConfirmation('')
    setBackupSubmitting(false)
    setBackupFailure('')
    setBackupNeedsRefresh(false)
    setQueuedBackupTask(undefined)
    void loadReview()
  }, [loadReview, open])

  const submitBackupDelete = async () => {
    if (!backupToDelete || backupConfirmation !== backupToDelete.name || backupSubmitting) return
    const submittedBackup = backupToDelete
    try {
      setBackupSubmitting(true)
      setBackupFailure('')
      const result = await api<{ backup: InstanceBackup; task: Task }>(`/instances/${instanceId}/backups/${submittedBackup.id}/delete`, {
        method: 'POST',
        body: { confirmName: backupConfirmation },
      })
      notifyTask(result.task)
      setQueuedBackupTask(result.task)
      setBackupToDelete(undefined)
      setBackupConfirmation('')
      message.success(t('backupDeleteQueued'))
      await loadReview()
    } catch (error) {
      setBackupFailure(errorMessage(error))
      setBackupConfirmation('')
      setBackupNeedsRefresh(true)
      setBackupToDelete(undefined)
      if (await loadReview()) setBackupNeedsRefresh(false)
    } finally {
      setBackupSubmitting(false)
    }
  }

  const submitDelete = async () => {
    if (!canSubmitInstanceDelete({ review, confirmation, submitting, needsRefresh })) return
    try {
      setSubmitting(true)
      setRequestFailure(undefined)
      const task = await api<Task>(`/instances/${instanceId}/actions/delete`, {
        method: 'POST',
        body: { confirmName: confirmation },
      })
      notifyTask(task)
      message.success(t('instanceDeleteQueued'))
      onClose()
      await onDeleteQueued(task)
    } catch (error) {
      setRequestFailure({
        code: error instanceof ApiError ? error.code : 'unknown',
        message: errorMessage(error),
      })
      setConfirmation('')
      setNeedsRefresh(true)
      await loadReview()
    } finally {
      setSubmitting(false)
    }
  }

  const evidence = instanceDeleteEvidence(review, loading, loadError)
  const canSubmit = canSubmitInstanceDelete({ review, confirmation, submitting, needsRefresh })
  const close = () => { if (!submitting && !backupSubmitting) onClose() }

  return <Modal
    title={`${t('deleteDatabase')} · ${review?.instanceName || instanceName}`}
    open={open}
    onCancel={close}
    width={640}
    closable={!submitting}
    maskClosable={!submitting}
    destroyOnHidden
    footer={<div className="cleanup-review-footer">
      <Button disabled={submitting} onClick={close}>{t('cancel')}</Button>
      <Button danger type="primary" icon={<DeleteOutlined />} loading={submitting} disabled={!canSubmit} onClick={() => void submitDelete()}>{t('confirmDeleteDatabase')}</Button>
    </div>}
  >
    <div className="cleanup-review">
      {evidence === 'loading' && <div className="cleanup-review-loading"><Spin /><Typography.Text type="secondary">{t('checkingDeleteReadiness')}</Typography.Text></div>}

      {evidence === 'error' && <Alert
        type="error"
        showIcon
        message={t('deleteReadinessLoadFailed')}
        description={loadError || t('deleteReadinessUnavailable')}
        action={<Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void loadReview({ clearFailure: true })}>{t('retry')}</Button>}
      />}

      {review && <Space wrap>
        <StatusTag value={review.status} />
        <Typography.Text type="secondary">{t('deleteDatabaseEvidenceSummary', { backups: review.backupCount })}</Typography.Text>
      </Space>}

      {evidence === 'blocked' && review && <Alert
        type="warning"
        showIcon
        message={t('deleteDatabaseBlockedTitle')}
        description={<div className="cleanup-blockers">
          <ul>
            {review.blockers.includes('active_operation') && <li>{t('deleteDatabaseActiveTaskBlocker', { task: review.activeTask ? translateCode(t, review.activeTask.kind, 'taskKind') : t('activeOperation') })}</li>}
            {review.blockers.includes('backups_present') && <li>{t('deleteDatabaseBackupBlocker', { count: review.backupCount })}</li>}
            {review.blockers.includes('status_not_deletable') && <li>{t('deleteDatabaseStatusBlocker', { status: translateCode(t, review.status) })}</li>}
          </ul>
          <Space wrap>
            {review.activeTask && <Button size="small" onClick={() => onOpenTask(review.activeTask!.id)}>{t('viewTask')}</Button>}
            <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void loadReview({ clearFailure: true })}>{t('refreshStatus')}</Button>
          </Space>
          {review.blockers.includes('backups_present') && <div className="cleanup-backup-list">
            <Typography.Text strong>{t('managedBackupsBlockingDeletion')}</Typography.Text>
            {backupsError && <Alert type="error" showIcon message={t('backupListLoadFailed')} description={backupsError} action={<Button size="small" onClick={() => void loadReview()}>{t('retry')}</Button>} />}
            {backups.map((backup) => <div className="cleanup-backup-item" key={backup.id}>
              <div>
                <Typography.Text strong>{backup.name}</Typography.Text>
                <Space size={6} wrap><StatusTag value={backup.status} /><Typography.Text type="secondary">{bytes(backup.sizeBytes)}</Typography.Text></Space>
              </div>
              <Button size="small" danger disabled={!['ready', 'failed'].includes(backup.status) || backupSubmitting || backupNeedsRefresh} onClick={() => { setBackupToDelete(backup); setBackupConfirmation(''); setBackupFailure(''); setBackupNeedsRefresh(false) }}>{t('deleteBackup')}</Button>
            </div>)}
            {backupFailure && <Alert type="error" showIcon message={t('backupRequestFailed', { action: t('deleteBackup') })} description={backupFailure} action={<Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void loadReview({ clearFailure: true })}>{t('refreshStatus')}</Button>} />}
            {queuedBackupTask && <Alert type="success" showIcon message={t('backupDeleteQueued')} description={t('backupDeleteQueuedHint')} action={<Button size="small" onClick={() => onOpenTask(queuedBackupTask.id)}>{t('viewTask')}</Button>} />}
          </div>}
        </div>}
      />}

      {evidence === 'ready' && review && <>
        <Alert type="error" showIcon message={t('deleteInstanceWarningTitle')} description={t('deleteInstanceWarningDescription')} />
        <Typography.Paragraph>{t('deleteInstanceConfirmHint', { name: review.instanceName })}</Typography.Paragraph>
        <Input
          autoFocus
          aria-label={t('deleteInstanceConfirmLabel', { name: review.instanceName })}
          value={confirmation}
          disabled={submitting || needsRefresh}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder={review.instanceName}
        />
      </>}

      {requestFailure && <Alert
        type="error"
        showIcon
        message={t('instanceDeleteRequestFailed')}
        description={<div className="instance-action-request-description">
          <div><Typography.Text type="secondary">{t('failureCause')}</Typography.Text><Typography.Text>{requestFailure.message}</Typography.Text></div>
          <div><Typography.Text type="secondary">{t('failureImpact')}</Typography.Text><Typography.Text>{t('instanceDeleteRequestImpact')}</Typography.Text></div>
          <div><Typography.Text type="secondary">{t('recoveryAdvice')}</Typography.Text><Typography.Text>{t(requestFailure.code === 'forbidden' || requestFailure.code === 'unauthorized' ? 'instanceDeleteRecoveryForbidden' : requestFailure.code === 'not_found' ? 'instanceDeleteRecoveryNotFound' : 'instanceDeleteRecoveryRefresh')}</Typography.Text></div>
        </div>}
        action={<Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void loadReview({ clearFailure: true })}>{t('refreshStatus')}</Button>}
      />}
    </div>
    <Modal
      title={`${t('deleteBackup')} · ${backupToDelete?.name || ''}`}
      open={!!backupToDelete}
      onCancel={() => { if (!backupSubmitting) { setBackupToDelete(undefined); setBackupConfirmation(''); setBackupFailure('') } }}
      onOk={() => void submitBackupDelete()}
      okText={t('deleteBackup')}
      cancelText={t('cancel')}
      confirmLoading={backupSubmitting}
      closable={!backupSubmitting}
      maskClosable={!backupSubmitting}
      okButtonProps={{ danger: true, disabled: !backupToDelete || backupConfirmation !== backupToDelete.name || backupNeedsRefresh }}
      destroyOnHidden
    >
      <Alert type="warning" showIcon message={t('deleteBackupWarning')} description={t('deleteBackupWarningHint')} />
      {backupToDelete && <Typography.Paragraph>{t('deleteBackupConfirmHint', { name: backupToDelete.name })}</Typography.Paragraph>}
      <Input autoFocus aria-label={t('deleteBackupConfirmLabel')} value={backupConfirmation} disabled={backupSubmitting || backupNeedsRefresh} onChange={(event) => setBackupConfirmation(event.target.value)} placeholder={backupToDelete?.name} />
      {backupFailure && <Alert className="backup-modal-alert" type="error" showIcon message={t('backupRequestFailed', { action: t('deleteBackup') })} description={backupFailure} />}
    </Modal>
  </Modal>
}
