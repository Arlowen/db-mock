import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { browserLocale, en, zh } from './i18n'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : []
  })
}

describe('internationalization coverage', () => {
  it('maps the browser language to a supported locale', () => {
    expect(browserLocale('zh-CN')).toBe('zh-CN')
    expect(browserLocale('zh-TW')).toBe('zh-CN')
    expect(browserLocale('en-GB')).toBe('en-US')
    expect(browserLocale('ja-JP')).toBe('en-US')
    expect(browserLocale('')).toBe('zh-CN')
  })

  it('keeps Chinese and English translation keys in sync', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('keeps the English interface free of Chinese fallback text', () => {
    const findings = Object.entries(en)
      .filter(([, value]) => /\p{Script=Han}/u.test(value))
      .map(([key]) => key)
    expect(findings).toEqual([])
  })

  it('does not leave obvious user-facing literals in TSX files', () => {
    const root = join(process.cwd(), 'src')
    const allowed = new Set(['DB Mock', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'])
    const findings: string[] = []
    const patterns = [
      /\b(?:description|label|placeholder|tooltip|title|okText|cancelText)="([^"]*[A-Za-z][^"]*)"/g,
      /\b(?:title|label|placeholder|tooltip|description)\s*:\s*['"]([A-Za-z][^'"]*)['"]/g,
      /<(?:p|span|Button|Typography\.(?:Text|Title|Paragraph))\b[^>{]*>\s*([A-Za-z][^<{]*?)\s*</g,
    ]
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8')
      if (/\p{Script=Han}/u.test(source)) findings.push(`${relative(root, file)}: contains hard-coded Chinese text`)
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
          const literal = match[1].trim()
          if (!allowed.has(literal)) findings.push(`${relative(root, file)}: ${literal}`)
        }
      }
    }
    expect(findings).toEqual([])
  })
})
