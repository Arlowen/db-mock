import i18n from '../i18n'

export const sessionInvalidatedEvent = 'dbmock:session-invalidated'

export class ApiError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

type RequestOptions = Omit<RequestInit, 'body'> & { body?: unknown }

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers)
  let body: BodyInit | undefined
  if (options.body instanceof Blob || options.body instanceof FormData || typeof options.body === 'string') {
    body = options.body
  } else if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(options.body)
  }
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    body,
    headers,
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: { code: 'http_error', message: response.statusText } }))
    if (response.status === 401) window.dispatchEvent(new Event(sessionInvalidatedEvent))
    throw new ApiError(response.status, payload.error?.code ?? 'http_error', payload.error?.message ?? response.statusText, payload.error?.details)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const summary = i18n.t(`error_${error.code}`, { defaultValue: error.message })
    if (!['invalid_input', 'resource_conflict', 'resource_unavailable'].includes(error.code)) return summary
    const detail = error.message.replace(/^(invalid input|resource conflict|resource temporarily unavailable):\s*/i, '').trim()
    if (!detail || detail.toLowerCase() === error.code.replaceAll('_', ' ')) return summary
    const detailKey = detail.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    const translationKey = `errorDetail_${detailKey}`
    if (!i18n.exists(translationKey)) {
      if (error.code === 'resource_unavailable' || i18n.language.startsWith('zh')) return summary
      return `${summary}: ${detail}`
    }
    const localized = i18n.t(translationKey, { defaultValue: detail })
    if (error.code === 'resource_unavailable') return localized
    return `${summary}: ${localized}`
  }
  return error instanceof Error ? error.message : String(error)
}
