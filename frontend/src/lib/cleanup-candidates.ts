import type { DashboardInstance } from './types'

export type CleanupCandidateFilter = 'all' | 'ready' | 'blocked'

export interface CleanupCandidateCounts {
  all: number
  ready: number
  blocked: number
  missingContext: number
}

export function cleanupCandidateMissingContext(item: DashboardInstance) {
  return !item.purpose.trim() || !item.owner.trim()
}

export function cleanupCandidateCounts(items: DashboardInstance[]): CleanupCandidateCounts {
  return items.reduce<CleanupCandidateCounts>((counts, item) => {
    counts.all += 1
    if (item.deleteReady) counts.ready += 1
    else counts.blocked += 1
    if (cleanupCandidateMissingContext(item)) counts.missingContext += 1
    return counts
  }, { all: 0, ready: 0, blocked: 0, missingContext: 0 })
}

export function filterCleanupCandidates(items: DashboardInstance[], filter: CleanupCandidateFilter) {
  if (filter === 'all') return items
  return items.filter((item) => filter === 'ready' ? item.deleteReady : !item.deleteReady)
}
