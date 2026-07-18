import { describe, expect, it } from 'vitest'
import { normalizeWebhookEvents } from './webhook-events'

describe('webhook event selection', () => {
  it('uses the wildcard by itself when it is selected', () => {
    expect(normalizeWebhookEvents(['alert.created'], ['alert.created', '*'])).toEqual(['*'])
  })

  it('removes the wildcard when a specific event is selected afterward', () => {
    expect(normalizeWebhookEvents(['*'], ['*', 'task.failed'])).toEqual(['task.failed'])
  })

  it('deduplicates specific events', () => {
    expect(normalizeWebhookEvents([], ['task.failed', 'task.failed'])).toEqual(['task.failed'])
  })
})
