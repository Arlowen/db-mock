import { Tag } from 'antd'
import { useTranslation } from 'react-i18next'
import { instanceLifecycleState } from '../lib/instance-lifecycle'

export function InstanceLifecycleTag({ expiresAt }: { expiresAt?: string }) {
  const { t } = useTranslation()
  const state = instanceLifecycleState(expiresAt)
  const color = state === 'expired' ? 'red' : state === 'dueSoon' ? 'orange' : state === 'scheduled' ? 'blue' : 'default'
  return <Tag color={color}>{t(`lifecycle_${state}`)}</Tag>
}
