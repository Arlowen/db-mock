import type { Task } from './types'

const activeStatuses = new Set(['queued', 'running'])
const failedStatuses = new Set(['failed', 'interrupted', 'canceled'])

export function selectRecoveryTasks(tasks: Task[], recoverable: boolean) {
  const activeTask = tasks.find((task) => activeStatuses.has(task.status))
  const latestTask = tasks[0]
  const failedTask = recoverable && latestTask && failedStatuses.has(latestTask.status) ? latestTask : undefined
  return { activeTask, failedTask, operationTask: activeTask || failedTask }
}
