import type { Task } from './types'

const activeStatuses = new Set(['queued', 'running', 'retrying'])
const cancellationPendingStatuses = new Set(['queued', 'running'])
const failedStatuses = new Set(['failed', 'interrupted', 'canceled'])
const retryableTaskKinds = new Set([
  'host.probe',
  'host.install_docker',
  'host.upgrade_docker',
  'host.configure_proxy',
  'instance.create',
  'instance.start',
  'instance.stop',
  'instance.restart',
  'instance.delete',
  'instance.backup.delete',
])
const recoverableInstanceStatuses = new Set(['provisioning', 'starting', 'stopping', 'restarting', 'upgrading', 'reconfiguring', 'backing_up', 'restoring', 'deleting', 'failed', 'degraded'])
const deploymentNextSteps: Record<string, string> = {
  queued: 'preflight',
  starting: 'preflight',
  preflight: 'tuning',
  tuning: 'image',
  image: 'render',
  render: 'compose',
  compose: 'health',
  health: 'handoff',
  finalize: 'handoff',
}

export type DeploymentTaskJourneyState = 'active' | 'ready' | 'incomplete'

export interface DeploymentTaskJourney {
  state: DeploymentTaskJourneyState
  instancePath: string
  connectionPath: string
}

export function isRecoverableInstanceStatus(status: string) {
  return recoverableInstanceStatuses.has(status)
}

export function isTaskCancellationPending(task: Task) {
  return task.cancelAsked && cancellationPendingStatuses.has(task.status)
}

export function canCancelTask(task: Task) {
  return task.cancelable && !task.cancelAsked && cancellationPendingStatuses.has(task.status)
}

export function canRetryTask(task: Task) {
  return failedStatuses.has(task.status) && retryableTaskKinds.has(task.kind)
}

export function deploymentTaskNextStep(task: Task) {
  if (task.kind.replaceAll('_', '.') !== 'instance.create' || !activeStatuses.has(task.status) || task.cancelAsked) return undefined
  return deploymentNextSteps[task.stage.replaceAll('.', '_')]
}

export function canReviewIncompleteDeploymentCleanup(task: Task) {
  return task.kind.replaceAll('_', '.') === 'instance.create' && failedStatuses.has(task.status)
}

export function selectRecoveryTasks(tasks: Task[], recoverable: boolean) {
  const activeTask = tasks.find((task) => activeStatuses.has(task.status))
  const latestTask = tasks[0]
  const failedTask = recoverable && latestTask && failedStatuses.has(latestTask.status) ? latestTask : undefined
  return { activeTask, failedTask, operationTask: activeTask || failedTask }
}

export function selectDeploymentHandoff(tasks: Task[], instanceStatus: string) {
  const task = tasks.find((candidate) => candidate.kind === 'instance.create')
  if (!task) return undefined
  if (activeStatuses.has(task.status)) return { state: 'active' as const, task }
  if (failedStatuses.has(task.status) && recoverableInstanceStatuses.has(instanceStatus)) return { state: 'failed' as const, task }
  if (task.status === 'succeeded' && instanceStatus === 'running') return { state: 'ready' as const, task }
  return undefined
}

export function deploymentTaskJourney(task: Task): DeploymentTaskJourney | undefined {
  if (task.kind.replaceAll('_', '.') !== 'instance.create' || task.resourceType !== 'instance' || !task.resourceId) return undefined
  const instancePath = `/instances/${encodeURIComponent(task.resourceId)}`
  const state: DeploymentTaskJourneyState = activeStatuses.has(task.status)
    ? 'active'
    : task.status === 'succeeded'
      ? 'ready'
      : 'incomplete'
  return { state, instancePath, connectionPath: `${instancePath}?tab=connection` }
}
