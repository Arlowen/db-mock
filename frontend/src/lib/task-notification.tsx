import { App, Button } from 'antd'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { Task } from './types'

export function useTaskNotification() {
  const { notification } = App.useApp()
  const navigate = useNavigate()
  const { t } = useTranslation()

  return useCallback((task: Task) => {
    const key = `task-${task.id}`
    notification.success({
      key,
      message: t('taskQueued'),
      description: t('taskQueuedDescription', { id: task.id.slice(0, 8) }),
      btn: <Button type="link" onClick={() => { notification.destroy(key); navigate(`/tasks?task=${task.id}`) }}>{t('viewTask')}</Button>,
      duration: 6,
    })
  }, [navigate, notification, t])
}
