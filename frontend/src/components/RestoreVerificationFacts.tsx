import { Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import { formatDateTime } from '../lib/localization'
import type { RestoreVerification } from '../lib/restore-verification'

export function RestoreVerificationFacts({ verification }: { verification: RestoreVerification }) {
  const { t, i18n } = useTranslation()
  const { timezone } = useSystemSettings()
  const backupLabel = verification.backupName || verification.backupId.slice(0, 8)

  return <div className="restore-verification-facts">
    <div>
      <Typography.Text type="secondary">{t('restoreVerificationDataVersion')}</Typography.Text>
      <Typography.Text strong>{backupLabel}</Typography.Text>
      {verification.backupSha256 && <Typography.Text type="secondary">{t('restoreVerificationChecksum', { checksum: verification.backupSha256.slice(0, 12) })}</Typography.Text>}
    </div>
    <div>
      <Typography.Text type="secondary">{t('restoreVerificationBackupTime')}</Typography.Text>
      <Typography.Text strong>{verification.backupCreatedAt ? formatDateTime(verification.backupCreatedAt, i18n.language, timezone) : t('restoreVerificationHistoricalEvidence')}</Typography.Text>
    </div>
    <div>
      <Typography.Text type="secondary">{t('restoreVerificationHealth')}</Typography.Text>
      <Typography.Text strong>{t('restoreVerificationHealthPassed')}</Typography.Text>
      {verification.healthVerifiedAt && <Typography.Text type="secondary">{formatDateTime(verification.healthVerifiedAt, i18n.language, timezone)}</Typography.Text>}
    </div>
  </div>
}
