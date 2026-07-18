export type InstanceQuickAction = 'start' | 'stop'

export function instanceQuickAction(status: string): InstanceQuickAction | null {
  if (status === 'running' || status === 'degraded') return 'stop'
  if (status === 'stopped') return 'start'
  return null
}
