export const DEFAULT_OPENAI_MODEL = 'gpt-5.5-mini'

const PROVIDER_MODEL_ALIASES: Record<string, string> = {
  // Product-facing Healix default. OpenAI's public API currently exposes this
  // capability under gpt-5-mini, so translate only at the provider boundary.
  'gpt-5.5-mini': 'gpt-5-mini',
}

export function resolveConfiguredOpenAIModel(override?: string | null): string {
  const explicit = String(override || '').trim()
  if (explicit) return explicit
  const envModel = process.env.OPENAI_MODEL?.trim()
  return envModel || DEFAULT_OPENAI_MODEL
}

export function resolveProviderOpenAIModel(model?: string | null): string {
  const configured = resolveConfiguredOpenAIModel(model)
  return PROVIDER_MODEL_ALIASES[configured] || configured
}
