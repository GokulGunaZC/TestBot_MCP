export const DEFAULT_OPENAI_MODEL = 'gpt-5.5-mini'

export function resolveConfiguredOpenAIModel(override?: string | null): string {
  const explicit = String(override || '').trim()
  if (explicit) return explicit
  const envModel = process.env.OPENAI_MODEL?.trim()
  return envModel || DEFAULT_OPENAI_MODEL
}
