import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import type { TaskRetryRequestFailure } from '../lib/task-retry-request'
import type { Task } from '../lib/types'
import { TaskRetryRequestRecovery } from './TaskRetryRequestRecovery'

const original = {
  id: 'failed-task',
  kind: 'instance.restart',
  status: 'failed',
  resourceType: 'instance',
  resourceId: 'instance-id',
  progress: 50,
  stage: 'compose',
  message: 'task_failed',
  payload: {},
  cancelable: false,
  cancelAsked: false,
  attempts: 1,
  createdAt: '2026-07-31T09:50:00.000Z',
} satisfies Task
const failure = {
  taskId: original.id,
  code: 'resource_conflict',
  message: 'another task is active',
  serverRejected: true,
  attemptedAt: '2026-07-31T10:00:00.000Z',
  evidenceChecks: 1,
} satisfies TaskRetryRequestFailure

beforeAll(async () => {
  await i18n.changeLanguage('en-US')
})

afterEach(cleanup)

describe('TaskRetryRequestRecovery', () => {
  it('shows the active blocker without offering another retry', () => {
    const blocker = { ...original, id: 'blocking-task', kind: 'instance.backup', status: 'running' }
    render(<I18nextProvider i18n={i18n}><TaskRetryRequestRecovery
      failure={failure}
      evidence={{ phase: 'blocked', original, blocker, canRetry: false }}
      onClose={vi.fn()}
      onOpenTask={vi.fn()}
      onRefresh={vi.fn()}
      onRetry={vi.fn()}
    /></I18nextProvider>)

    expect(screen.getByText('Task retry was not queued')).toBeInTheDocument()
    expect(screen.getByText('Task currently using this resource')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry task' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View current task' })).toBeInTheDocument()
  })

  it('keeps retry hidden for read-only users even when evidence is ready', () => {
    render(<I18nextProvider i18n={i18n}><TaskRetryRequestRecovery
      failure={failure}
      evidence={{ phase: 'ready', original, canRetry: true }}
      showRetry={false}
      onClose={vi.fn()}
      onOpenTask={vi.fn()}
      onRefresh={vi.fn()}
      onRetry={vi.fn()}
    /></I18nextProvider>)

    expect(screen.getByText('Evidence is current and shows no new retry task or active conflict. It is safe to retry again.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry task' })).not.toBeInTheDocument()
    expect(screen.getByText('Refresh task evidence')).toBeInTheDocument()
  })
})
