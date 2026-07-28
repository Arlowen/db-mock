import { Alert, List, Modal, Space, Typography } from 'antd'
import { ArrowRightOutlined, ClockCircleOutlined, SaveOutlined } from '@ant-design/icons'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { InstanceLifecycleTag } from './InstanceLifecycle'
import { cleanupDecisionPreview, type CleanupDecision } from '../lib/cleanup-decisions'
import { formatDateTime } from '../lib/localization'
import type { DashboardInstance } from '../lib/types'

interface Props {
  decision?: CleanupDecision
  items: DashboardInstance[]
  submitting: boolean
  requestError: string
  timezone: string
  onCancel: () => void
  onSubmit: () => void
}

export function CleanupBatchDecisionModal({
  decision,
  items,
  submitting,
  requestError,
  timezone,
  onCancel,
  onSubmit,
}: Props) {
  const { t, i18n } = useTranslation()
  const previews = useMemo(
    () => decision ? items.map((item) => cleanupDecisionPreview(item, decision, decision === 'extend' ? 7 : 0)) : [],
    [decision, items],
  )
  const extending = decision === 'extend'

  return <Modal
    title={decision ? t(extending ? 'batchCleanupExtendTitle' : 'batchCleanupRetainTitle', { count: items.length }) : ''}
    open={!!decision}
    onCancel={onCancel}
    onOk={onSubmit}
    okText={t(extending ? 'confirmBatchCleanupExtend' : 'confirmBatchCleanupRetain', { count: items.length })}
    cancelText={t('cancel')}
    confirmLoading={submitting}
    closable={!submitting}
    maskClosable={!submitting}
    okButtonProps={{ disabled: !decision || items.length === 0 }}
    width={760}
    destroyOnHidden
  >
    <div className="cleanup-batch-confirm">
      <Alert
        type="info"
        showIcon
        icon={extending ? <ClockCircleOutlined /> : <SaveOutlined />}
        message={t(extending ? 'batchCleanupExtendImpact' : 'batchCleanupRetainImpact')}
        description={t('batchCleanupRuntimeUnaffected')}
      />
      <div className="cleanup-batch-preview-header">
        <Typography.Text strong>{t('batchCleanupPreviewTitle')}</Typography.Text>
        <Typography.Text type="secondary">{t('batchCleanupPreviewCount', { count: previews.length })}</Typography.Text>
      </div>
      <List
        className="cleanup-batch-preview"
        size="small"
        bordered
        dataSource={previews}
        renderItem={(preview) => <List.Item>
          <div className="cleanup-batch-preview-row">
            <div>
              <Typography.Text strong>{preview.instance.name}</Typography.Text>
              <Typography.Text type="secondary">{preview.instance.owner || t('ownerMissing')} · {preview.instance.purpose || t('purposeMissing')}</Typography.Text>
            </div>
            <Space size={6} wrap className="cleanup-batch-preview-expiry">
              <InstanceLifecycleTag expiresAt={preview.instance.expiresAt} />
              <Typography.Text type="secondary">{formatDateTime(preview.instance.expiresAt, i18n.language, timezone)}</Typography.Text>
              <ArrowRightOutlined aria-hidden />
              <Typography.Text strong>{preview.nextExpiresAt ? formatDateTime(preview.nextExpiresAt, i18n.language, timezone) : t('retainIndefinitely')}</Typography.Text>
            </Space>
          </div>
        </List.Item>}
      />
      {requestError && <Alert type="error" showIcon message={t('batchCleanupRequestFailed')} description={requestError} />}
    </div>
  </Modal>
}
