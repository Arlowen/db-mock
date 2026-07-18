import i18n from '../i18n'

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

export type ImageUploadPhase = 'resuming' | 'uploading' | 'verifying'

function imageUploadResumeKey(file: File): string {
  return `dbmock-upload:${file.name}:${file.size}:${file.lastModified}`
}

export async function discardImageUpload(file: File): Promise<void> {
  const resumeKey = imageUploadResumeKey(file)
  const uploadID = localStorage.getItem(resumeKey)
  if (!uploadID) return
  try { await api(`/images/uploads/${uploadID}`, { method: 'DELETE' }) } finally { localStorage.removeItem(resumeKey) }
}

export async function uploadInChunks(
  file: File,
  onProgress: (percent: number) => void,
  expectedSha256 = '',
  displayName = file.name,
  onPhase: (phase: ImageUploadPhase) => void = () => undefined,
  signal?: AbortSignal,
): Promise<unknown> {
  const resumeKey = imageUploadResumeKey(file)
  let upload: { id: string; receivedBytes: number; totalBytes?: number; status?: string } | undefined
  const previousID = localStorage.getItem(resumeKey)
  if (previousID) {
    try {
      const candidate = await api<typeof upload>(`/images/uploads/${previousID}`)
      if (candidate?.totalBytes === file.size && candidate.status === 'uploading') upload = candidate
    } catch { localStorage.removeItem(resumeKey) }
  }
  if (!upload) {
    onPhase('uploading')
    upload = await api<{ id: string; receivedBytes: number }>('/images/uploads', {
      method: 'POST',
      body: { filename: file.name, totalBytes: file.size, sha256: expectedSha256 },
      signal,
    })
    localStorage.setItem(resumeKey, upload.id)
  } else {
    onPhase('resuming')
  }
  const chunkSize = 8 * 1024 * 1024
  let offset = upload.receivedBytes
  onProgress(Math.round((offset / file.size) * 100))
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size))
    await api(`/images/uploads/${upload.id}/chunk?offset=${offset}`, { method: 'PUT', body: chunk, signal })
    offset += chunk.size
    onProgress(Math.round((offset / file.size) * 100))
    onPhase('uploading')
  }
  onPhase('verifying')
  try {
    const result = await api(`/images/uploads/${upload.id}/complete`, { method: 'POST', body: { name: displayName }, signal })
    localStorage.removeItem(resumeKey)
    return result
  } catch (error) {
    if (error instanceof ApiError && error.status === 400) {
      await discardImageUpload(file).catch(() => localStorage.removeItem(resumeKey))
    }
    throw error
  }
}
