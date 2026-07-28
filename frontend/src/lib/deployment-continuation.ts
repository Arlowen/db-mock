const continuationOrigin = 'https://dbmock.invalid'

export function safeCreateReturnPath(value: string | null | undefined): string {
  if (!value?.startsWith('/')) return ''
  try {
    const parsed = new URL(value, continuationOrigin)
    if (parsed.origin !== continuationOrigin || parsed.pathname !== '/instances' || parsed.searchParams.get('create') !== '1') return ''
    return `${parsed.pathname}?${parsed.searchParams.toString()}`
  } catch {
    return ''
  }
}

export function deploymentReturnPathForHost(value: string | null | undefined, hostId: string | null | undefined): string {
  const safePath = safeCreateReturnPath(value)
  if (!safePath) return ''
  const normalizedHostId = hostId?.trim()
  if (!normalizedHostId) return safePath
  const parsed = new URL(safePath, continuationOrigin)
  parsed.searchParams.set('host', normalizedHostId)
  return `${parsed.pathname}?${parsed.searchParams.toString()}`
}
