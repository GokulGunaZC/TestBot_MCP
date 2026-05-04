import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { apiKeys } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { hashApiKey } from '@/lib/utils/api-keys'
import { checkRateLimit } from '@/lib/rate-limit'
import { logBlockedRequest } from '@/lib/security-logger'

const ENDPOINT = '/api/llm-proxy/chat/completions'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions'

// Exploration calls can take up to 3 minutes per LLM round-trip
export const maxDuration = 300

export async function POST(request: NextRequest) {
  try {
    // 0. Server-side OpenAI key must be configured
    if (!OPENAI_API_KEY) {
      return NextResponse.json({ error: { message: 'Server OpenAI key not configured', type: 'server_error', code: 'server_error' } }, { status: 503 })
    }

    // 1. Extract HEALIX_API_KEY from Authorization: Bearer {key} header (OpenAI SDK style)
    //    or x-api-key header (MCP style)
    const authHeader = request.headers.get('authorization') ?? ''
    const api_key = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : (request.headers.get('x-api-key') ?? '')

    if (!api_key) {
      logBlockedRequest({ type: 'MISSING_API_KEY', reason: 'No Authorization Bearer or x-api-key header', endpoint: ENDPOINT })
      return NextResponse.json(
        { error: { message: 'No API key provided', type: 'invalid_request_error', code: 'missing_api_key' } },
        { status: 401 }
      )
    }

    // 2. Authenticate against HEALIX_API_KEY records
    const keyHash = hashApiKey(api_key)
    const [apiKeyRecord] = await db
      .select({ id: apiKeys.id, userId: apiKeys.userId, isActive: apiKeys.isActive, revoked: apiKeys.revoked, expiresAt: apiKeys.expiresAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.isActive, true)))
      .limit(1)

    if (!apiKeyRecord) {
      logBlockedRequest({ type: 'INVALID_API_KEY', reason: 'Key not found or inactive', endpoint: ENDPOINT })
      return NextResponse.json(
        { error: { message: 'Invalid or inactive API key', type: 'invalid_request_error', code: 'invalid_api_key' } },
        { status: 401 }
      )
    }

    if (apiKeyRecord.revoked) {
      logBlockedRequest({ type: 'REVOKED_API_KEY', user_id: apiKeyRecord.userId, reason: 'API key has been revoked', endpoint: ENDPOINT })
      return NextResponse.json(
        { error: { message: 'API key has been revoked', type: 'invalid_request_error', code: 'invalid_api_key' } },
        { status: 401 }
      )
    }

    if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
      logBlockedRequest({ type: 'EXPIRED_API_KEY', user_id: apiKeyRecord.userId, reason: 'API key has expired', endpoint: ENDPOINT })
      return NextResponse.json(
        { error: { message: 'API key has expired', type: 'invalid_request_error', code: 'invalid_api_key' } },
        { status: 401 }
      )
    }

    const userId = apiKeyRecord.userId

    // 3. Rate limit — exploration calls can be frequent (one per browser-use step)
    const rateResult = await checkRateLimit({ keyHash, userId, endpoint: ENDPOINT })
    if (!rateResult.allowed) {
      return NextResponse.json(
        { error: { message: 'Rate limit exceeded', type: 'requests', code: 'rate_limit_exceeded' } },
        { status: 429, headers: { 'Retry-After': String(rateResult.retryAfter ?? 1) } }
      )
    }

    // 4. Read raw body — forward as-is to OpenAI, preserving model/messages/stream exactly
    const rawBody = await request.text()
    let isStream = false
    try {
      isStream = (JSON.parse(rawBody) as { stream?: boolean })?.stream === true
    } catch { /* not JSON or missing stream field — treat as non-streaming */ }

    // 5. Forward to OpenAI with server-side OPENAI_API_KEY
    const upstreamRes = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: rawBody,
    })

    // 6. Propagate upstream errors in OpenAI error format
    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text()
      return new Response(errText, {
        status: upstreamRes.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // 7. Update last_used_at on successful proxy call
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKeyRecord.id))
      .catch(() => { /* non-fatal */ })

    // 8. Return — stream SSE chunks if the client requested streaming,
    //    otherwise buffer and return JSON
    if (isStream && upstreamRes.body) {
      return new Response(upstreamRes.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      })
    }

    const responseBody = await upstreamRes.json()
    return NextResponse.json(responseBody)

  } catch (error) {
    console.error('[llm-proxy] error:', error)
    return NextResponse.json(
      { error: { message: error instanceof Error ? error.message : 'Internal server error', type: 'internal_error', code: 'internal_error' } },
      { status: 500 }
    )
  }
}
