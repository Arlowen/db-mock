import i18n from '../i18n'

export type AppLocale = 'zh-CN' | 'en-US'

export function normalizeLocale(value: string | undefined): AppLocale {
  return value === 'en-US' ? 'en-US' : 'zh-CN'
}

export function oppositeLocale(value: string): AppLocale {
  return normalizeLocale(value) === 'zh-CN' ? 'en-US' : 'zh-CN'
}

export async function applyLocale(value: string): Promise<AppLocale> {
  const locale = normalizeLocale(value)
  await i18n.changeLanguage(locale)
  localStorage.setItem('dbmock-locale', locale)
  return locale
}
