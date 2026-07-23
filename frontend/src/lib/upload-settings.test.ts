import { describe, expect, it } from 'vitest'
import { GiB, isUploadSettingsFormValid, MiB, normalizeUploadSettings, uploadSettingsFromForm, uploadSettingsToForm } from './upload-settings'

describe('upload settings', () => {
  it('normalizes the effective server policy and deployment ceiling', () => {
    expect(normalizeUploadSettings({ maxBytes: 10 * GiB, chunkBytes: 4 * MiB, maxAllowedBytes: 20 * GiB })).toEqual({
      maxBytes: 10 * GiB,
      chunkBytes: 4 * MiB,
      maxAllowedBytes: 20 * GiB,
    })
  })

  it('clamps malformed values and round-trips form units', () => {
    const normalized = normalizeUploadSettings({ maxBytes: 100 * GiB, chunkBytes: 64 * MiB, maxAllowedBytes: 40 * GiB })
    expect(normalized).toEqual({ maxBytes: 40 * GiB, chunkBytes: 32 * MiB, maxAllowedBytes: 40 * GiB })
    expect(uploadSettingsFromForm(uploadSettingsToForm(normalized))).toEqual({ maxBytes: 40 * GiB, chunkBytes: 32 * MiB })
  })

  it('requires the upload limit to cover each whole browser chunk', () => {
    expect(isUploadSettingsFormValid({ maxGiB: 10, chunkMiB: 8 }, 20 * GiB)).toBe(true)
    expect(isUploadSettingsFormValid({ maxGiB: 1 / 1024, chunkMiB: 2 }, 20 * GiB)).toBe(false)
    expect(isUploadSettingsFormValid({ maxGiB: 10, chunkMiB: 2.5 }, 20 * GiB)).toBe(false)
    expect(isUploadSettingsFormValid({ maxGiB: 30, chunkMiB: 8 }, 20 * GiB)).toBe(false)
  })
})
