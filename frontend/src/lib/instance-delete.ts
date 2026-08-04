import type { InstanceCleanupReview } from './types'

export type InstanceDeleteEvidence = 'loading' | 'error' | 'blocked' | 'ready'

export function instanceDeleteEvidence(
  review: InstanceCleanupReview | undefined,
  loading: boolean,
  loadError: string,
): InstanceDeleteEvidence {
  if (loading && !review) return 'loading'
  if (loadError || !review) return 'error'
  return review.deleteReady ? 'ready' : 'blocked'
}

export function canSubmitInstanceDelete({
  review,
  confirmation,
  submitting,
  needsRefresh,
}: {
  review?: InstanceCleanupReview
  confirmation: string
  submitting: boolean
  needsRefresh: boolean
}) {
  return Boolean(
    review?.deleteReady &&
    confirmation === review.instanceName &&
    !submitting &&
    !needsRefresh,
  )
}
