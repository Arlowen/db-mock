export type InstanceLifecycleAction = 'start' | 'stop' | 'restart'

export function instanceListActions(status: string): InstanceLifecycleAction[] {
  if (status === 'running' || status === 'degraded') return ['restart', 'stop']
  if (status === 'stopped') return ['start']
  return []
}
