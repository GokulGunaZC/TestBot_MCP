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
          : 540_000 // 9 min — gpt-5.4-mini can take minutes per call at reasoning:high

    const envEffort = String(process.env.OPENAI_REASONING_EFFORT || '').toLowerCase()
    // Default 'medium' for gpt-5.4-mini: 2–3× faster than 'high' and 'high' occasionally
    // emits only a reasoning block with no message (→ tests:[] → pipeline failure).
    // Medium returns a message reliably in ~2s. Override via OPENAI_REASONING_EFFORT
    // or the per-client config option.
    const resolvedEffort: 'low' | 'medium' | 'high' =
      config.reasoningEffort ??
      (envEffort === 'low' || envEffort === 'medium' || envEffort === 'high'
        ? (envEffort as 'low' | 'medium' | 'high')
        : 'medium')

    const resolvedModel = config.model || process.env.OPENAI_MODEL || 'gpt-4.1-mini'
    this.config = {
      apiKey: config.apiKey,
      model: resolvedModel,
      chatFallbackModel: resolvedModel,
      latestGPTModel: resolvedModel,
      modelFallbacks: [],
      maxTokens:
        config.maxTokens || parseInt(process.env.OPENAI_MAX_TOKENS || '4000') || 4000,
      temperature: config.temperature ?? 0.2,
      timeout: timeoutMs,
      reasoningEffort: resolvedEffort,
    }
  }

  async callOpenAI(
    messages: OpenAIMessage[],
    options: {
      model?: string
      // External abort — when fired, the in-flight OpenAI fetch dies. Used by
      // dispatchAgents to cancel parallel fan-out the moment the user's
      // balance hits 0, so we don't keep paying OpenAI for tokens the user
      // can't be charged for.
      signal?: AbortSignal
    } = {},
  ): Promise<OpenAICallResult> {
    const model = this.config.model
    try {
      const result = await this.callResponsesAPI(messages, model, options.signal)
      return { text: result.text, usage: result.usage, modelUsed: model }
    } catch (err) {
      // Bubble user-initiated aborts — never fall back to Chat Completions on
      // an abort, that would defeat the whole point of cancelling.
      if (err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))) {
        throw err
      }
      // Responses API failed (model not found, format unsupported, etc.) —
      // fall back to Chat Completions so the pipeline keeps working.
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[openai-client] Responses API failed (${msg}), falling back to Chat Completions`)
      const result = await this.callChatCompletionsAPI(messages, model, options.signal)
      return { text: result.text, usage: result.usage, modelUsed: model }
    }
  }

  // Combine our internal timeout controller with an optional external signal.
  // Returns the composite signal plus a cleanup that clears the timeout.
  private composeAbortSignal(externalSignal?: AbortSignal): {
    signal: AbortSignal
    cleanup: () => void
  } {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('TIMEOUT')), this.config.timeout)
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason ?? new Error('ABORTED'))
      } else {
        externalSignal.addEventListener(
          'abort',
          () => controller.abort(externalSignal.reason ?? new Error('ABORTED')),
          { once: true },
        )
      }
    }
    return { signal: controller.signal, cleanup: () => clearTimeout(timeout) }
  }

  buildPreferredModelList(_requestedModel: string): string[] {
    return [this.config.model]
  }

  isLikelyCodexModel(_model: string): boolean {
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

  async callResponsesAPI(
    messages: OpenAIMessage[],
    model: string,
    externalSignal?: AbortSignal,
  ): Promise<{ text: string; usage: OpenAIUsage }> {
    const RETRYABLE = new Set([502, 503, 504])
    const MAX_ATTEMPTS = 3
    const RETRY_DELAYS_MS = [0, 3000, 6000]

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (RETRY_DELAYS_MS[attempt] > 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]))
      }

      // External abort early-out before paying for setup overhead.
      if (externalSignal?.aborted) {
        throw new Error('OpenAI request aborted by caller')
      }

      const { signal, cleanup } = this.composeAbortSignal(externalSignal)

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
            // Hard ceiling on output tokens. Output is 6× the price of input
            // on gpt-5.4-mini, so a runaway agent (we saw 47K out on the
            // workflow agent during demo) can blow $0.20+ per call. Cap is
            // sourced from this.config.maxTokens (env: OPENAI_MAX_TOKENS;
            // default 12K — see constructor) so it can be tuned without code
            // changes.
            max_output_tokens: this.config.maxTokens,
          }),
          signal,
        })

        if (!response.ok) {
          if (RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
            cleanup()
            continue
          }
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
        cleanup()
        // Distinguish caller-initiated abort from our own timeout so the
        // dispatcher can mark agents 'cancelled' instead of 'failed'.
        if (externalSignal?.aborted) {
          throw new Error('OpenAI request aborted by caller')
        }
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`OpenAI responses API request timeout (${Math.ceil(this.config.timeout / 1000)}s)`)
        }
        throw error
      } finally {
        cleanup()
      }
    }

    throw new Error('OpenAI responses API failed after retries')
  }

  async callChatCompletionsAPI(
    messages: OpenAIMessage[],
    model: string,
    externalSignal?: AbortSignal,
  ): Promise<{ text: string; usage: OpenAIUsage }> {
    if (externalSignal?.aborted) {
      throw new Error('OpenAI request aborted by caller')
    }
    const { signal, cleanup } = this.composeAbortSignal(externalSignal)

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
          // Same hard ceiling as the Responses API path — see comment above.
          max_completion_tokens: this.config.maxTokens,
        }),
        signal,
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
      if (externalSignal?.aborted) {
        throw new Error('OpenAI request aborted by caller')
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`OpenAI chat API request timeout (${Math.ceil(this.config.timeout / 1000)}s)`)
      }
      throw error
    } finally {
      cleanup()
    }
  }
}
