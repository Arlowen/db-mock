const fallback = new Map<string, string>()

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage || undefined
  } catch {
    return undefined
  }
}

export function getStoredValue(key: string): string | null {
  const storage = browserStorage()
  if (!storage) return fallback.get(key) ?? null
  try {
    return storage.getItem(key)
  } catch {
    return fallback.get(key) ?? null
  }
}

export function setStoredValue(key: string, value: string): void {
  fallback.set(key, value)
  try {
    browserStorage()?.setItem(key, value)
  } catch {
    // Keep the value in memory when browser storage is disabled or full.
  }
}

export function removeStoredValue(key: string): void {
  fallback.delete(key)
  try {
    browserStorage()?.removeItem(key)
  } catch {
    // The in-memory value is already removed.
  }
}
