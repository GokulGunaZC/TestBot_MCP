/**
 * OpenAI Client for Backend Test Generation
 * Ported from testbot-mcp/src/ai-providers/openai.js
 * Uses fetch-based API calls (both Chat Completions and Responses API)
 */

import type { OpenAIClientConfig, OpenAIMessage, OpenAIUsage, OpenAICallResult } from './types'

export class OpenAIClient {
  config: Required<OpenAIClientConfig>
  private baseUrl = 'https://api.openai.com/v1'

  constructor(config: OpenAIClientConfig) {
    const envTimeout = Number(process.env.OPENAI_TIMEOUT_MS)
    const timeoutMs =
      Number.isFinite(Number(config.timeout)) && Number(config.timeout) > 0
        ? Number(config.timeout)
        : Number.isFinite(envTimeout) && envTimeout > 0
          ? envTimeout
          : 540_000 // 9 min — gpt-5.4 can take minutes per call at reasoning:high

    const envEffort = String(process.env.OPENAI_REASONING_EFFORT || '').toLowerCase()
    // Default 'medium' for gpt-5.4: 2–3× faster than 'high' and 'high' occasionally
    // emits only a reasoning block with no message (→ tests:[] → pipeline failure).
    // Medium returns a message reliably in ~2s. Override via OPENAI_REASONING_EFFORT
    // or the per-client config option.
    const resolvedEffort: 'low' | 'medium' | 'high' =
      config.reasoningEffort ??
      (envEffort === 'low' || envEffort === 'medium' || envEffort === 'high'
        ? (envEffort as 'low' | 'medium' | 'high')
        : 'medium')

    // gpt-5.4 only. No chat-fallback, no model alternates.
    // gpt-5.4 runs on the Responses API (/v1/responses) with `input` +
    // `reasoning`, per https://developers.openai.com/api/docs/quickstart.
    this.config = {
      apiKey: config.apiKey,
      model: 'gpt-5.4',
      chatFallbackModel: 'gpt-5.4',
      latestGPTModel: 'gpt-5.4',
      modelFallbacks: [],
      maxTokens:
        config.maxTokens || parseInt(process.env.OPENAI_MAX_TOKENS || '4000') || 4000,
      temperature: config.temperature ?? 0.2,
      timeout: timeoutMs,
      reasoningEffort: resolvedEffort,
    }
  }

  async callOpenAI(messages: OpenAIMessage[], _options: { model?: string } = {}): Promise<OpenAICallResult> {
    // Single model, single endpoint. No silent failover.
    const result = await this.callResponsesAPI(messages, 'gpt-5.4')
    return { text: result.text, usage: result.usage, modelUsed: 'gpt-5.4' }
  }

  buildPreferredModelList(_requestedModel: string): string[] {
    return ['gpt-5.4']
  }

  isLikelyCodexModel(_model: string): boolean {
    // All our calls go through gpt-5.4 on the Responses API.
    return true
  }

  buildResponsesInput(messages: OpenAIMessage[]): string {
    if (!Array.isArray(messages)) return ''
    return messages
      .map((message) => {
        const role = String(message?.role || 'user').toUpperCase()
        const content = String(message?.content || '').trim()
        return `${role}:\n${content}`
      })
      .join('\n\n')
  }

  extractResponseText(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null
    const p = payload as Record<string, unknown>

    if (typeof p.output_text === 'string' && p.output_text.trim()) {
      return p.output_text.trim()
    }

    if (Array.isArray(p.output)) {
      const chunks: string[] = []
      for (const item of p.output) {
        const content = Array.isArray((item as Record<string, unknown>)?.content)
          ? (item as Record<string, unknown>).content as unknown[]
          : []
        for (const part of content) {
          const partObj = part as Record<string, unknown>
          if (typeof partObj?.text === 'string' && partObj.text.trim()) {
            chunks.push(partObj.text.trim())
          }
        }
      }
      if (chunks.length > 0) return chunks.join('\n').trim()
    }

    const choices = p.choices as Array<{ message?: { content?: unknown } }> | undefined
    const chatContent = choices?.[0]?.message?.content
    if (typeof chatContent === 'string' && chatContent.trim()) {
      return chatContent.trim()
    }

    if (Array.isArray(chatContent)) {
      const flattened = (chatContent as Array<{ text?: string }>)
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim()
      if (flattened) return flattened
    }

    return null
  }

  async callResponsesAPI(messages: OpenAIMessage[], model: string): Promise<{ text: string; usage: OpenAIUsage }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeout)

    try {
      const response = await fetch(`${this.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: this.buildResponsesInput(messages),
          reasoning: { effort: this.config.reasoningEffort || 'high' },
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const errorMsg = (errorData as { error?: { message?: string } }).error?.message || `HTTP ${response.status}`
        throw new Error(`OpenAI responses API error: ${errorMsg}`)
      }

      const data = await response.json() as Record<string, unknown>
      const text = this.extractResponseText(data)
      if (!text) throw new Error('Responses API returned no text content')
      const rawUsage = data.usage as Record<string, unknown> | undefined
      const usage: OpenAIUsage = {
        promptTokens: (rawUsage?.input_tokens as number) ?? 0,
        completionTokens: (rawUsage?.output_tokens as number) ?? 0,
        totalTokens: (rawUsage?.total_tokens as number) ?? ((rawUsage?.input_tokens as number ?? 0) + (rawUsage?.output_tokens as number ?? 0)),
      }
      return { text, usage }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`OpenAI responses API request timeout (${Math.ceil(this.config.timeout / 1000)}s)`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  async callChatCompletionsAPI(messages: OpenAIMessage[], model: string): Promise<{ text: string; usage: OpenAIUsage }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeout)

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: this.config.temperature,
          max_tokens: this.config.maxTokens,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const errorMsg = (errorData as { error?: { message?: string } }).error?.message || `HTTP ${response.status}`
        throw new Error(`OpenAI chat API error: ${errorMsg}`)
      }

      const data = await response.json() as Record<string, unknown>
      const text = this.extractResponseText(data)
      if (!text) throw new Error('Chat completions API returned no text content')
      const rawUsage = data.usage as Record<string, unknown> | undefined
      const usage: OpenAIUsage = {
        promptTokens: (rawUsage?.prompt_tokens as number) ?? 0,
        completionTokens: (rawUsage?.completion_tokens as number) ?? 0,
        totalTokens: (rawUsage?.total_tokens as number) ?? ((rawUsage?.prompt_tokens as number ?? 0) + (rawUsage?.completion_tokens as number ?? 0)),
      }
      return { text, usage }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`OpenAI chat API request timeout (${Math.ceil(this.config.timeout / 1000)}s)`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}
