import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Task } from './types'
import { useTaskRetryRequest } from './use-task-retry-request'

const attemptedTask = {
  id: 'failed-task',
  kind: 'instance.restart',
  status: 'failed',
  resourceType: 'instance',
  resourceId: 'instance-id',
  progress: 50,
  stage: 'compose',
  message: 'task_failed',
  payload: { operationId: 'operation-id' },
  cancelable: false,
  cancelAsked: false,
  attempts: 1,
  createdAt: '2026-07-31T09:50:00.000Z',
} satisfies Task

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useTaskRetryRequest', () => {
  it('keeps a rejected retry blocked until current resource work clears', async () => {
    const blocker = {
      ...attemptedTask,
      id: 'blocking-task',
      kind: 'instance.backup',
      status: 'running',
      payload: { operationId: 'blocking-operation' },
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'resource_conflict', message: 'another task is active' } }, 409))
      .mockResolvedValueOnce(jsonResponse({ items: [attemptedTask, blocker] }))
      .mockResolvedValueOnce(jsonResponse({ items: [attemptedTask] }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTaskRetryRequest())

    await act(async () => {
      expect(await result.current.request(attemptedTask)).toBeUndefined()
    })
    expect(result.current.evidence).toMatchObject({ phase: 'blocked', blocker, canRetry: false })

    await act(async () => {
      expect(await result.current.refresh()).toBeUndefined()
    })
    expect(result.current.evidence).toMatchObject({ phase: 'ready', canRetry: true })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/v1/tasks/failed-task/retry',
      '/api/v1/tasks',
      '/api/v1/tasks',
    ])
  })

  it('requires two evidence reads before retrying after an ambiguous network outcome', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(jsonResponse({ items: [attemptedTask] }))
      .mockResolvedValueOnce(jsonResponse({ items: [attemptedTask] }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTaskRetryRequest())

    await act(async () => {
      await result.current.request(attemptedTask)
    })
    expect(result.current.evidence).toMatchObject({ phase: 'stale', canRetry: false })

    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.evidence).toMatchObject({ phase: 'ready', canRetry: true })
  })

  it('returns a successor found by the evidence read instead of offering another retry', async () => {
    const successor = {
      ...attemptedTask,
      id: 'successor-task',
      status: 'queued',
      createdAt: new Date(Date.now() + 1000).toISOString(),
    }
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(jsonResponse({ items: [attemptedTask, successor] }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useTaskRetryRequest())
    let accepted: Task | undefined

    await act(async () => {
      accepted = await result.current.request(attemptedTask)
    })
    expect(accepted).toEqual(successor)
    expect(result.current.failure).toBeNull()
    expect(result.current.evidence).toBeUndefined()
  })
})
