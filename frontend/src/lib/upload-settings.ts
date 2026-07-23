export const MiB = 1024 * 1024
export const GiB = 1024 * MiB

export interface UploadSettings {
  maxBytes: number
  chunkBytes: number
  maxAllowedBytes: number
}

export interface UploadSettingsForm {
  maxGiB: number
  chunkMiB: number
}

export const defaultUploadSettings: UploadSettings = {
  maxBytes: 50 * GiB,
  chunkBytes: 8 * MiB,
  maxAllowedBytes: 50 * GiB,
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

export function normalizeUploadSettings(value: unknown): UploadSettings {
  const source = record(value)
  const maxAllowedBytes = positiveNumber(source.maxAllowedBytes, defaultUploadSettings.maxAllowedBytes)
  const maxBytes = Math.min(positiveNumber(source.maxBytes, Math.min(defaultUploadSettings.maxBytes, maxAllowedBytes)), maxAllowedBytes)
  const chunkBytes = Math.min(positiveNumber(source.chunkBytes, defaultUploadSettings.chunkBytes), 32 * MiB, maxBytes)
  return { maxBytes, chunkBytes, maxAllowedBytes }
}

export function uploadSettingsToForm(settings: UploadSettings): UploadSettingsForm {
  return {
    maxGiB: settings.maxBytes / GiB,
    chunkMiB: settings.chunkBytes / MiB,
  }
}

export function uploadSettingsFromForm(form: UploadSettingsForm): Pick<UploadSettings, 'maxBytes' | 'chunkBytes'> {
  return {
    maxBytes: Math.round(form.maxGiB * GiB),
    chunkBytes: Math.round(form.chunkMiB * MiB),
  }
}

export function isUploadSettingsFormValid(value: unknown, maxAllowedBytes: number): value is UploadSettingsForm {
  const source = record(value)
  const maxGiB = source.maxGiB
  const chunkMiB = source.chunkMiB
  const maxAllowedGiB = maxAllowedBytes / GiB
  const maxAllowedMiB = maxAllowedBytes / MiB
  return typeof maxGiB === 'number'
    && Number.isFinite(maxGiB)
    && maxGiB >= 1 / 1024
    && maxGiB <= maxAllowedGiB
    && typeof chunkMiB === 'number'
    && Number.isInteger(chunkMiB)
    && chunkMiB >= 1
    && chunkMiB <= Math.min(32, maxAllowedMiB)
    && maxGiB * GiB >= chunkMiB * MiB
}
