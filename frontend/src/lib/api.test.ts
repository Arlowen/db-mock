import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import { ApiError, errorMessage, uploadInChunks } from './api'

describe('API error messages', () => {
  beforeEach(async () => { await i18n.changeLanguage('zh-CN') })

  it('keeps the useful backend detail when a translated recovery message exists', () => {
    expect(errorMessage(new ApiError(409, 'resource_conflict', 'resource conflict: registry is used by managed database instances')))
      .toBe('资源状态冲突: 该仓库仍被数据库实例使用，无法删除。')
  })

  it('turns late host port races into an actionable localized message', () => {
    expect(errorMessage(new ApiError(409, 'resource_conflict', 'resource conflict: requested port is not available on the selected host')))
      .toBe('资源状态冲突: 指定端口不在所选主机的端口池内，或已被其他实例占用。')
  })

  it('explains conflicting instance operations in the active language', () => {
    expect(errorMessage(new ApiError(409, 'resource_conflict', 'resource conflict: another operation is already queued or running for this resource')))
      .toBe('资源状态冲突: 该实例已有操作正在排队或执行，请在任务完成后重试。')
  })

  it('does not expose an untranslated infrastructure error in place of the recovery hint', () => {
    expect(errorMessage(new ApiError(503, 'resource_unavailable', 'resource temporarily unavailable: unable to reach the instance host over SSH')))
      .toBe('暂时无法通过 SSH 连接实例主机，请检查主机网络与 SSH 配置')
  })

  it('explains when host capacity cannot be detected', () => {
    expect(errorMessage(new ApiError(503, 'resource_unavailable', 'resource temporarily unavailable: unable to determine host CPU, memory, or disk capacity')))
      .toBe('无法读取主机的 CPU、内存或磁盘容量，请确认 SSH 用户可以读取系统资源信息。')
  })

  it('does not mix untranslated backend validation details into the Chinese interface', () => {
    expect(errorMessage(new ApiError(400, 'invalid_input', 'invalid input: unexpected backend validation detail')))
      .toBe('输入内容无效')
  })

  it('explains how to recover from an incomplete Docker image archive', () => {
    expect(errorMessage(new ApiError(400, 'invalid_input', 'invalid input: Docker save archive is incomplete')))
      .toBe('输入内容无效: Docker save 归档不完整，缺少有效配置或镜像层。请重新执行 docker save 后上传。')
  })

  it('keeps useful backend validation details in the English interface', async () => {
    await i18n.changeLanguage('en-US')
    expect(errorMessage(new ApiError(400, 'invalid_input', 'invalid input: unexpected backend validation detail')))
      .toBe('Invalid input: unexpected backend validation detail')
  })
})

describe('chunked image uploads', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => localStorage.clear())
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('resumes from the persisted offset and exposes the verification phase', async () => {
    const file = new File([new Uint8Array(10)], 'postgres.tar', { lastModified: 1234 })
    localStorage.setItem('dbmock-upload:postgres.tar:10:1234', 'upload-1')
    const requests: Array<{ url: string; method: string }> = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ url, method })
      if (method === 'GET') return Response.json({ id: 'upload-1', receivedBytes: 4, totalBytes: 10, status: 'uploading' })
      if (method === 'PUT') return new Response(null, { status: 204 })
      return Response.json({ id: 'image-1' })
    })
    const progress: number[] = []
    const phases: string[] = []

    await uploadInChunks(file, (value) => progress.push(value), '', 'PostgreSQL', (phase) => phases.push(phase))

    expect(requests).toEqual([
      { url: '/api/v1/images/uploads/upload-1', method: 'GET' },
      { url: '/api/v1/images/uploads/upload-1/chunk?offset=4', method: 'PUT' },
      { url: '/api/v1/images/uploads/upload-1/complete', method: 'POST' },
    ])
    expect(progress).toEqual([40, 100])
    expect(phases).toEqual(['resuming', 'uploading', 'verifying'])
    expect(localStorage.getItem('dbmock-upload:postgres.tar:10:1234')).toBeNull()
  })

  it('deletes an invalid upload session so choosing the same file starts cleanly', async () => {
    const file = new File([new Uint8Array(4)], 'broken.tar', { lastModified: 5678 })
    const methods: string[] = []
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      methods.push(method)
      if (method === 'POST' && methods.length === 1) return Response.json({ id: 'upload-2', receivedBytes: 0 })
      if (method === 'PUT' || method === 'DELETE') return new Response(null, { status: 204 })
      return Response.json({ error: { code: 'invalid_input', message: 'invalid input: file is not a Docker save or OCI image archive' } }, { status: 400 })
    })

    await expect(uploadInChunks(file, () => undefined)).rejects.toMatchObject({ status: 400, code: 'invalid_input' })

    expect(methods).toEqual(['POST', 'PUT', 'POST', 'DELETE'])
    expect(localStorage.getItem('dbmock-upload:broken.tar:4:5678')).toBeNull()
  })
})
