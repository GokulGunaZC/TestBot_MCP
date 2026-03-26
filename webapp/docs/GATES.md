# Request Gates — TestBot Webapp

Every inbound request to a protected endpoint passes through a sequential chain of gates.
A request is rejected as soon as the **first** gate it fails is reached; later gates are never evaluated.

---

## Endpoint covered

```
POST /api/test-runs/ingest
```

_(The same gate ordering is replicated in `/api/generate-tests` and `/api/analyze-failures`.)_

---

## Gate chain (in order)

```
Request
  │
  ▼ Gate 1 ── API Key present?          no  → 401 { error: "Missing api_key" }
  │
  ▼ Gate 2 ── API Key valid & active?   no  → 401 { error: "Invalid or inactive API key" }
  │            Key revoked?             yes → 401 { error: "API key has been revoked" }
  │            Key expired?             yes → 401 { error: "API key has expired" }
  │
  ▼ Gate 3 ── Rate limit OK?            no  → 429 { error: "RATE_LIMIT_EXCEEDED" }
  │                                          Header: Retry-After: <seconds>
  │
  ▼ Gate 4 ── Concurrency limit OK?     no  → 429 { error: "CONCURRENT_LIMIT_EXCEEDED" }
  │
  ▼ Gate 5 ── Idempotency (if key set)  dup → 200 <cached response body>
  │
  ▼ Gate 6 ── Input valid?              no  → 422 { field, message, max, actual }
  │
  ▼ Gate 7 ── Credits remaining > 0?    no  → 402 { error: "No credits remaining…" }
  │
  ▼ Handler — insert test run, return 200 { success: true, test_run_id, dashboard_url }
```

---

## Gate 1 — API Key presence

**File:** `src/app/api/test-runs/ingest/route.ts`

The key is read from the `x-api-key` request header, falling back to a `api_key` body field.

```http
# Missing key
POST /api/test-runs/ingest
Content-Type: application/json

{ "report": { "tests": [] } }

→ 401 { "error": "Missing api_key" }
```

```http
# Correct header
POST /api/test-runs/ingest
x-api-key: tb_0f04fe...
Content-Type: application/json

{ "report": { ... } }

→ passes to Gate 2
```

---

## Gate 2 — API Key authentication

**File:** `src/app/api/test-runs/ingest/route.ts`, `src/lib/utils/api-keys.ts`

The raw key is SHA-256 hashed (`hashApiKey`) and looked up in the `api_keys` table.
Three sub-checks run after a record is found:

| Sub-check | Condition | Response |
|-----------|-----------|----------|
| Not found / inactive | `isActive = false` or no row | `401 Invalid or inactive API key` |
| Revoked | `revoked = true` | `401 API key has been revoked` |
| Expired | `expiresAt < now()` | `401 API key has expired` |

```http
# Invalid key
POST /api/test-runs/ingest
x-api-key: tb_invalid000000000000000000000000

→ 401 { "error": "Invalid or inactive API key" }
```

All failures are written to the `security_logs` table via `logBlockedRequest`.

---

## Gate 3 — Rate limit

**File:** `src/lib/rate-limit.ts`

Sliding-window counter, keyed on the hashed API key.
Falls back to an in-process `Map` when `REDIS_URL` is not set; uses Redis sorted sets when it is.

| Window | Default limit | Env override |
|--------|--------------|--------------|
| Per second | 10 req/s | `RATE_LIMIT_PER_SECOND` |
| Per minute | 200 req/min | `RATE_LIMIT_PER_MINUTE` |

```http
# 11th request within 1 second
→ 429 { "error": "RATE_LIMIT_EXCEEDED" }
     Retry-After: 1
```

A `Retry-After` header (seconds) is always included so clients know when to retry.

---

## Gate 4 — Concurrency limit

**File:** `src/lib/concurrency-limit.ts`

Counts `test_runs` rows with `status = 'running'` for the authenticated user.
Default ceiling is **3 simultaneous runs** (override with `MAX_CONCURRENT_RUNS`).

```http
# User already has 3 running test runs
→ 429 { "error": "CONCURRENT_LIMIT_EXCEEDED" }
```

---

## Gate 5 — Idempotency (optional, pass-through)

**File:** `src/lib/idempotency.ts`

If the client sends `x-idempotency-key`, the server caches the response for that key.
A duplicate request with the same key returns the cached body immediately (status 200) without
re-running the handler or deducting another credit.

```http
# First call
POST /api/test-runs/ingest
x-api-key: tb_0f04fe...
x-idempotency-key: my-run-abc123

→ 200 { "success": true, "test_run_id": "run_xyz" }

# Exact same idempotency key repeated
POST /api/test-runs/ingest
x-api-key: tb_0f04fe...
x-idempotency-key: my-run-abc123

→ 200 { "success": true, "test_run_id": "run_xyz" }   ← same cached body, no credit deducted
```

---

## Gate 6 — Input validation

**File:** `src/lib/validation.ts`

Checks `report.tests` array length. Rejects payloads exceeding `MAX_TESTS_PER_RUN * 10`.

```http
# Too many tests
POST /api/test-runs/ingest
x-api-key: tb_0f04fe...

{ "report": { "tests": [ /* 50 001 items */ ] } }

→ 422 { "field": "report.tests", "message": "...", "max": 50000, "actual": 50001 }
```

---

## Gate 7 — Credit gate

**File:** `src/lib/credits.ts`

Atomically decrements `profiles.credits_remaining` in a single
`UPDATE … WHERE credits_remaining > 0 RETURNING …` statement.
This eliminates read-then-write races (no TOCTOU).

```sql
-- What happens internally
UPDATE profiles
SET    credits_remaining = credits_remaining - 1
WHERE  id = '<userId>'
  AND  credits_remaining > 0
RETURNING credits_remaining;
-- 0 rows returned → 402; 1 row returned → allowed
```

```http
# Account has 0 credits
→ 402 {
    "error": "No credits remaining. Please upgrade your plan or purchase more credits."
  }

# Account has ≥ 1 credit
→ passes to handler; credit_remaining decremented by 1
```

**Fail-closed:** any DB error during the decrement propagates as a thrown exception (not swallowed),
so an infrastructure failure cannot accidentally grant free credits.

---

## Authentication gate (UI / middleware)

**File:** `src/middleware.ts` (Next.js middleware)

Separate from the API key chain above. Applies to all dashboard routes.
A Supabase session cookie is required. Missing or expired → redirect to:

```
/login?redirectedFrom=<original-path>
```

```
GET /home  (no session cookie)
→ 302 Location: /login?redirectedFrom=%2Fhome
```

Protected routes:
`/home`, `/all-tests`, `/test-lists`, `/api-keys`, `/profile`, `/plan-billing`, `/monitoring`, `/create-tests`, `/mcp-tests`

---

## Security logging

Every gate failure is recorded in the `security_logs` table via `logBlockedRequest`:

| Field | Content |
|-------|---------|
| `type` | `MISSING_API_KEY` \| `INVALID_API_KEY` \| `REVOKED_API_KEY` \| `EXPIRED_API_KEY` \| `RATE_LIMIT_EXCEEDED` \| `CONCURRENT_LIMIT_EXCEEDED` \| `NO_CREDITS` \| `INVALID_INPUT_LIMIT` |
| `user_id` | Resolved user ID (when available) |
| `reason` | Human-readable description |
| `endpoint` | Route that rejected the request |
| `metadata` | Extra context (e.g. `retryAfter`, active run count) |
