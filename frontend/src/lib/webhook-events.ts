export function normalizeWebhookEvents(previous: string[], next: string[]): string[] {
  const unique = Array.from(new Set(next))
  if (!unique.includes('*')) return unique
  if (!previous.includes('*')) return ['*']
  return unique.filter((event) => event !== '*')
}
