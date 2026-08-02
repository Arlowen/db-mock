import { useCallback, useMemo, useState } from 'react'
import { ApiError, api, errorMessage } from './api'
import {
  taskRetryRequestEvidence,
  type TaskRetryRequestFailure,
} from './task-retry-request'
import type { Task } from './types'

export function useTaskRetryRequest() {
  const [failure, setFailure] = useState<TaskRetryRequestFailure | null>(null)
  const [evidenceItems, setEvidenceItems] = useState<Task[]>([])
  const [refreshError, setRefreshError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [submittingTaskID, setSubmittingTaskID] = useState('')
  const evidence = useMemo(
    () => failure ? taskRetryRequestEvidence(failure, evidenceItems) : undefined,
    [evidenceItems, failure],
  )

  const clear = useCallback(() => {
    setFailure(null)
    setEvidenceItems([])
    setRefreshError('')
  }, [])

  const request = useCallback(async (task: Pick<Task, 'id'>): Promise<Task | undefined> => {
    const attemptedAt = new Date().toISOString()
    try {
      setSubmittingTaskID(task.id)
      clear()
      return await api<Task>(`/tasks/${encodeURIComponent(task.id)}/retry`, { method: 'POST', body: {} })
    } catch (error) {
      const nextFailure: TaskRetryRequestFailure = {
        taskId: task.id,
        code: error instanceof ApiError ? error.code : 'network_error',
        message: errorMessage(error),
        serverRejected: error instanceof ApiError,
        attemptedAt,
        evidenceChecks: 0,
      }
      try {
        const response = await api<{ items: Task[] }>('/tasks')
        const confirmedFailure = { ...nextFailure, evidenceChecks: 1 }
        const nextEvidence = taskRetryRequestEvidence(confirmedFailure, response.items)
        setEvidenceItems(response.items)
        setRefreshError('')
        if (nextEvidence.successor) {
          clear()
          return nextEvidence.successor
        }
        setFailure(confirmedFailure)
      } catch (evidenceError) {
        setRefreshError(errorMessage(evidenceError))
        setFailure(nextFailure)
      }
      return undefined
    } finally {
      setSubmittingTaskID('')
    }
  }, [clear])

  const refresh = useCallback(async (): Promise<Task | undefined> => {
    if (!failure) return undefined
    try {
      setRefreshing(true)
      setRefreshError('')
      const response = await api<{ items: Task[] }>('/tasks')
      const nextFailure = { ...failure, evidenceChecks: failure.evidenceChecks + 1 }
      const nextEvidence = taskRetryRequestEvidence(nextFailure, response.items)
      setEvidenceItems(response.items)
      if (nextEvidence.successor) {
        clear()
        return nextEvidence.successor
      }
      setFailure(nextFailure)
      return undefined
    } catch (error) {
      setRefreshError(errorMessage(error))
      return undefined
    } finally {
      setRefreshing(false)
    }
  }, [clear, failure])

  return {
    clear,
    evidence,
    failure,
    refresh,
    refreshing,
    refreshError,
    request,
    submittingTaskID,
  }
}
