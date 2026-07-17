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
  return error instanceof Error ? error.message : String(error)
}

export async function uploadInChunks(
  file: File,
  onProgress: (percent: number) => void,
  expectedSha256 = '',
): Promise<unknown> {
  const resumeKey = `dbmock-upload:${file.name}:${file.size}:${file.lastModified}`
  let upload: { id: string; receivedBytes: number; totalBytes?: number; status?: string } | undefined
  const previousID = localStorage.getItem(resumeKey)
  if (previousID) {
    try {
      const candidate = await api<typeof upload>(`/images/uploads/${previousID}`)
      if (candidate?.totalBytes === file.size && candidate.status === 'uploading') upload = candidate
    } catch { localStorage.removeItem(resumeKey) }
  }
  if (!upload) {
    upload = await api<{ id: string; receivedBytes: number }>('/images/uploads', {
      method: 'POST',
      body: { filename: file.name, totalBytes: file.size, sha256: expectedSha256 },
    })
    localStorage.setItem(resumeKey, upload.id)
  }
  const chunkSize = 8 * 1024 * 1024
  let offset = upload.receivedBytes
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size))
    await api(`/images/uploads/${upload.id}/chunk?offset=${offset}`, { method: 'PUT', body: chunk })
    offset += chunk.size
    onProgress(Math.round((offset / file.size) * 100))
  }
  const result = await api(`/images/uploads/${upload.id}/complete`, { method: 'POST', body: { name: file.name } })
  localStorage.removeItem(resumeKey)
  return result
}
