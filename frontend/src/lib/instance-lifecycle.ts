export type InstanceLifecycleState = 'retained' | 'scheduled' | 'dueSoon' | 'expired'

const dueSoonWindow = 7 * 24 * 60 * 60 * 1000

export function instanceLifecycleState(expiresAt?: string, now = Date.now()): InstanceLifecycleState {
  if (!expiresAt) return 'retained'
  const expiry = new Date(expiresAt).getTime()
  if (Number.isNaN(expiry)) return 'retained'
  if (expiry <= now) return 'expired'
  if (expiry <= now + dueSoonWindow) return 'dueSoon'
  return 'scheduled'
}

export function lifecycleCounts(items: Array<{ expiresAt: string }>, now = Date.now()) {
  return items.reduce((counts, item) => {
    const state = instanceLifecycleState(item.expiresAt, now)
    if (state === 'expired') counts.expired += 1
    if (state === 'dueSoon') counts.dueSoon += 1
    return counts
  }, { expired: 0, dueSoon: 0 })
}
