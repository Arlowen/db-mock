import { Collapse, Space, Tag, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { taskFailureGuidance } from '../lib/task-failure'
import type { Task } from '../lib/types'

interface TaskFailureGuidanceProps {
  task: Pick<Task, 'kind' | 'status' | 'result' | 'errorCode' | 'errorMessage'>
  hostName?: string
}

export function TaskFailureGuidance({ task, hostName }: TaskFailureGuidanceProps) {
  const { t } = useTranslation()
  const guidance = taskFailureGuidance(task)
  return <div className="task-failure-guidance">
    <div className="task-failure-guidance-grid">
      <div className="task-failure-guidance-item">
        <Typography.Text type="secondary">{t('failureCause')}</Typography.Text>
        <Typography.Text strong>{t(guidance.causeKey, { host: hostName || t('targetHost') })}</Typography.Text>
      </div>
      <div className="task-failure-guidance-item">
        <Typography.Text type="secondary">{t('failureImpact')}</Typography.Text>
        <Typography.Text>{t(guidance.impactKey)}</Typography.Text>
      </div>
      <div className="task-failure-guidance-item">
        <Typography.Text type="secondary">{t('recoveryAdvice')}</Typography.Text>
        <Typography.Text>{t(guidance.recoveryKey, { host: hostName || t('targetHost') })}</Typography.Text>
      </div>
    </div>
    {task.errorMessage && <Collapse
      className="task-failure-technical"
      ghost
      size="small"
      items={[{
        key: 'technical',
        label: t('technicalDetails'),
        children: <Space size={6} wrap>
          {task.errorCode && <Tag color="red">{task.errorCode}</Tag>}
          <Typography.Text code copyable>{task.errorMessage}</Typography.Text>
        </Space>,
      }]}
    />}
  </div>
}
