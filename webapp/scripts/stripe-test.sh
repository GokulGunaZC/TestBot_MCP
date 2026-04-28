#!/usr/bin/env bash
# =============================================================================
# stripe-test.sh — Healix Stripe webhook integration test suite
#
# Fires all supported webhook event types against the local dev server and
# verifies the expected database state after each one.
#
# Usage:
#   ./scripts/stripe-test.sh                          # default test user
#   ./scripts/stripe-test.sh --user-id <uuid>         # specific user
#   ./scripts/stripe-test.sh --base-url <url>         # non-default base URL
#   ./scripts/stripe-test.sh --skip-db-checks         # skip DB verification
#
# Prerequisites:
#   - Next.js dev server running on $BASE_URL
#   - DATABASE_URL in .env.local
#   - Optional: Stripe CLI at /tmp/stripe or in PATH (for trigger-based tests)
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Config & defaults
# ---------------------------------------------------------------------------

BASE_URL="http://localhost:3000"
USER_ID=""
SKIP_DB=false
STRIPE_CLI=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --user-id)   USER_ID="$2";   shift 2 ;;
    --base-url)  BASE_URL="$2";  shift 2 ;;
    --skip-db-checks) SKIP_DB=true; shift ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

WEBHOOK_URL="$BASE_URL/api/stripe/webhook"

# ---------------------------------------------------------------------------
# Colours
# ---------------------------------------------------------------------------

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

pass()  { echo -e "  ${GREEN}✓${RESET} $1"; }
fail()  { echo -e "  ${RED}✗${RESET} $1"; FAILURES=$((FAILURES + 1)); }
info()  { echo -e "  ${CYAN}→${RESET} $1"; }
warn()  { echo -e "  ${YELLOW}!${RESET} $1"; }
header(){ echo -e "\n${BOLD}${BLUE}$1${RESET}"; echo "  $(printf '─%.0s' {1..60})"; }

FAILURES=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

FAKE_CUSTOMER="cus_healix_test_$(date +%s)"
FAKE_SUB="sub_healix_test_$(date +%s)"

# Locate Stripe CLI
if command -v stripe &>/dev/null; then
  STRIPE_CLI="stripe"
elif [[ -x "/tmp/stripe" ]]; then
  STRIPE_CLI="/tmp/stripe"
fi

# Resolve test user ID from DB if not provided
resolve_user_id() {
  if [[ -n "$USER_ID" ]]; then return; fi
  info "No --user-id provided — fetching first profile from DB..."
  USER_ID=$(node --env-file=.env.local -e "
    import('postgres').then(({ default: p }) => {
      const db = p(process.env.DATABASE_URL, { ssl: 'require', max: 1 })
      db\`SELECT id FROM profiles LIMIT 1\`
        .then(rows => { console.log(rows[0]?.id ?? ''); db.end() })
        .catch(() => { db.end(); process.exit(1) })
    })" 2>/dev/null)
  if [[ -z "$USER_ID" ]]; then
    fail "Could not resolve a test user ID from the database"
    exit 1
  fi
  info "Using user ID: $USER_ID"
}

# POST a raw JSON webhook payload
send_event() {
  local payload="$1"
  curl -s -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -H "stripe-signature: dev-bypass" \
    -d "$payload"
}

# Query a single field from the profiles table
db_field() {
  local field="$1"
  node --env-file=.env.local -e "
    import('postgres').then(({ default: p }) => {
      const db = p(process.env.DATABASE_URL, { ssl: 'require', max: 1 })
      db\`SELECT $field FROM profiles WHERE id = '${USER_ID}'\`
        .then(rows => { console.log(rows[0]?.['$field'] ?? 'NULL'); db.end() })
        .catch(e => { console.log('DB_ERROR: ' + e.message); db.end() })
    })" 2>/dev/null
}

assert_field() {
  local field="$1" expected="$2"
  if $SKIP_DB; then return; fi
  local actual
  actual=$(db_field "$field")
  if [[ "$actual" == "$expected" ]]; then
    pass "DB: $field = $expected"
  else
    fail "DB: $field — expected '$expected', got '$actual'"
  fi
}

check_received() {
  local response="$1" label="$2"
  if echo "$response" | grep -q '"received":true'; then
    pass "$label → 200 received:true"
  else
    fail "$label → unexpected response: $response"
  fi
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

header "Pre-flight Checks"

# Check dev server
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL" 2>/dev/null || echo "000")
if [[ "$HTTP_STATUS" == "200" ]]; then
  pass "Dev server is up at $BASE_URL"
else
  fail "Dev server not responding at $BASE_URL (status: $HTTP_STATUS)"
  echo -e "\n${RED}Aborting — start the dev server first: npm run dev${RESET}"
  exit 1
fi

# Check Stripe CLI
if [[ -n "$STRIPE_CLI" ]]; then
  pass "Stripe CLI found: $STRIPE_CLI ($($STRIPE_CLI version 2>/dev/null | head -1))"
else
  warn "Stripe CLI not found — trigger-based tests will be skipped"
  warn "Download: curl -sL https://github.com/stripe/stripe-cli/releases/download/v1.40.7/stripe_1.40.7_linux_x86_64.tar.gz | tar -xz -C /tmp/"
fi

resolve_user_id
info "Webhook URL: $WEBHOOK_URL"
info "Customer:    $FAKE_CUSTOMER"
info "Subscription: $FAKE_SUB"

# ---------------------------------------------------------------------------
# Test 1 — checkout.session.completed (initial subscription)
# ---------------------------------------------------------------------------

header "Test 1 — checkout.session.completed"
info "Simulates a user completing payment for the Team plan"

RESPONSE=$(send_event "{
  \"type\": \"checkout.session.completed\",
  \"id\": \"evt_test_checkout_001\",
  \"data\": {
    \"object\": {
      \"id\": \"cs_test_001\",
      \"object\": \"checkout.session\",
      \"mode\": \"subscription\",
      \"customer\": \"$FAKE_CUSTOMER\",
      \"subscription\": \"$FAKE_SUB\",
      \"client_reference_id\": \"$USER_ID\",
      \"metadata\": { \"plan\": \"team\", \"userId\": \"$USER_ID\" }
    }
  }
}")

check_received "$RESPONSE" "checkout.session.completed"
assert_field "plan" "team"
assert_field "tokens_total" "4800000"
assert_field "tokens_remaining" "4800000"
assert_field "stripe_customer_id" "$FAKE_CUSTOMER"
assert_field "stripe_subscription_id" "$FAKE_SUB"
assert_field "subscription_status" "active"

# ---------------------------------------------------------------------------
# Test 2 — checkout.session.completed (idempotency — duplicate event)
# ---------------------------------------------------------------------------

header "Test 2 — checkout.session.completed (idempotency)"
info "Same event replayed — DB should remain unchanged"

RESPONSE=$(send_event "{
  \"type\": \"checkout.session.completed\",
  \"id\": \"evt_test_checkout_001_DUPE\",
  \"data\": {
    \"object\": {
      \"id\": \"cs_test_001\",
      \"object\": \"checkout.session\",
      \"mode\": \"subscription\",
      \"customer\": \"$FAKE_CUSTOMER\",
      \"subscription\": \"$FAKE_SUB\",
      \"client_reference_id\": \"$USER_ID\",
      \"metadata\": { \"plan\": \"team\", \"userId\": \"$USER_ID\" }
    }
  }
}")

check_received "$RESPONSE" "checkout.session.completed (duplicate)"
assert_field "subscription_status" "active"

# ---------------------------------------------------------------------------
# Test 3 — invoice.paid (subscription_create — should be ignored)
# ---------------------------------------------------------------------------

header "Test 3 — invoice.paid (subscription_create — no-op)"
info "Initial invoice — tokens already granted by checkout; must not double-grant"

# First burn some tokens to detect if they get incorrectly reset
if ! $SKIP_DB; then
  node --env-file=.env.local -e "
    import('postgres').then(({ default: p }) => {
      const db = p(process.env.DATABASE_URL, { ssl: 'require', max: 1 })
      db\`UPDATE profiles SET tokens_remaining = 999999 WHERE id = '${USER_ID}'\`
        .then(() => { db.end() })
    })" 2>/dev/null
  info "Burned tokens_remaining to 999999"
fi

RESPONSE=$(send_event "{
  \"type\": \"invoice.paid\",
  \"id\": \"evt_test_invoice_create\",
  \"data\": {
    \"object\": {
      \"id\": \"in_test_create\",
      \"object\": \"invoice\",
      \"status\": \"paid\",
      \"customer\": \"$FAKE_CUSTOMER\",
      \"billing_reason\": \"subscription_create\",
      \"parent\": {
        \"type\": \"subscription_details\",
        \"subscription_details\": {
          \"subscription\": \"$FAKE_SUB\",
          \"metadata\": {}
        }
      }
    }
  }
}")

check_received "$RESPONSE" "invoice.paid (subscription_create)"
assert_field "tokens_remaining" "999999"  # must not have been reset

# ---------------------------------------------------------------------------
# Test 4 — invoice.paid (subscription_cycle — monthly renewal)
# ---------------------------------------------------------------------------

header "Test 4 — invoice.paid (subscription_cycle — monthly renewal)"
info "Monthly renewal resets tokens back to plan allocation"

RESPONSE=$(send_event "{
  \"type\": \"invoice.paid\",
  \"id\": \"evt_test_invoice_cycle_001\",
  \"data\": {
    \"object\": {
      \"id\": \"in_test_cycle_001\",
      \"object\": \"invoice\",
      \"status\": \"paid\",
      \"customer\": \"$FAKE_CUSTOMER\",
      \"billing_reason\": \"subscription_cycle\",
      \"parent\": {
        \"type\": \"subscription_details\",
        \"subscription_details\": {
          \"subscription\": \"$FAKE_SUB\",
          \"metadata\": {}
        }
      }
    }
  }
}")

check_received "$RESPONSE" "invoice.paid (subscription_cycle)"
assert_field "tokens_remaining" "4800000"
assert_field "subscription_status" "active"
assert_field "stripe_last_invoice_id" "in_test_cycle_001"

# ---------------------------------------------------------------------------
# Test 5 — invoice.paid duplicate (idempotency)
# ---------------------------------------------------------------------------

header "Test 5 — invoice.paid (idempotency — same invoice replayed)"
info "Replaying the same invoice ID — tokens must not be double-granted"

if ! $SKIP_DB; then
  node --env-file=.env.local -e "
    import('postgres').then(({ default: p }) => {
      const db = p(process.env.DATABASE_URL, { ssl: 'require', max: 1 })
      db\`UPDATE profiles SET tokens_remaining = 111111 WHERE id = '${USER_ID}'\`
        .then(() => { db.end() })
    })" 2>/dev/null
  info "Burned tokens_remaining to 111111 to detect double-grant"
fi

RESPONSE=$(send_event "{
  \"type\": \"invoice.paid\",
  \"id\": \"evt_test_invoice_cycle_001_DUPE\",
  \"data\": {
    \"object\": {
      \"id\": \"in_test_cycle_001\",
      \"object\": \"invoice\",
      \"status\": \"paid\",
      \"customer\": \"$FAKE_CUSTOMER\",
      \"billing_reason\": \"subscription_cycle\",
      \"parent\": {
        \"type\": \"subscription_details\",
        \"subscription_details\": {
          \"subscription\": \"$FAKE_SUB\",
          \"metadata\": {}
        }
      }
    }
  }
}")

check_received "$RESPONSE" "invoice.paid (duplicate)"
assert_field "tokens_remaining" "111111"  # unchanged — idempotency worked

# ---------------------------------------------------------------------------
# Test 6 — invoice.payment_failed
# ---------------------------------------------------------------------------

header "Test 6 — invoice.payment_failed"
info "Payment failure marks subscription as past_due without revoking tokens"

RESPONSE=$(send_event "{
  \"type\": \"invoice.payment_failed\",
  \"id\": \"evt_test_payment_failed_001\",
  \"data\": {
    \"object\": {
      \"id\": \"in_test_failed_001\",
      \"object\": \"invoice\",
      \"customer\": \"$FAKE_CUSTOMER\",
      \"billing_reason\": \"subscription_cycle\",
      \"parent\": {
        \"type\": \"subscription_details\",
        \"subscription_details\": {
          \"subscription\": \"$FAKE_SUB\",
          \"metadata\": {}
        }
      }
    }
  }
}")

check_received "$RESPONSE" "invoice.payment_failed"
assert_field "subscription_status" "past_due"
assert_field "tokens_remaining" "111111"  # tokens preserved during grace period

# ---------------------------------------------------------------------------
# Test 7 — customer.subscription.deleted (wrong sub ID — upgrade guard)
# ---------------------------------------------------------------------------

header "Test 7 — customer.subscription.deleted (upgrade guard)"
info "Old subscription deleted after upgrade — must NOT downgrade user"

RESPONSE=$(send_event "{
  \"type\": \"customer.subscription.deleted\",
  \"id\": \"evt_test_sub_deleted_old\",
  \"data\": {
    \"object\": {
      \"id\": \"sub_OLD_should_be_ignored\",
      \"object\": \"subscription\",
      \"customer\": \"$FAKE_CUSTOMER\",
      \"metadata\": {}
    }
  }
}")

check_received "$RESPONSE" "customer.subscription.deleted (wrong sub)"
assert_field "plan" "team"                 # must still be team
assert_field "subscription_status" "past_due"  # unchanged

# ---------------------------------------------------------------------------
# Test 8 — customer.subscription.deleted (correct sub ID — cancellation)
# ---------------------------------------------------------------------------

header "Test 8 — customer.subscription.deleted (cancellation)"
info "Active subscription cancelled — reverts user to free plan"

RESPONSE=$(send_event "{
  \"type\": \"customer.subscription.deleted\",
  \"id\": \"evt_test_sub_deleted_correct\",
  \"data\": {
    \"object\": {
      \"id\": \"$FAKE_SUB\",
      \"object\": \"subscription\",
      \"customer\": \"$FAKE_CUSTOMER\",
      \"metadata\": {}
    }
  }
}")

check_received "$RESPONSE" "customer.subscription.deleted (correct sub)"
assert_field "plan" "free"
assert_field "tokens_total" "240000"
assert_field "tokens_remaining" "240000"
assert_field "subscription_status" "cancelled"
assert_field "stripe_subscription_id" "NULL"

# ---------------------------------------------------------------------------
# Test 9 — invoice.created (invoice customization)
# ---------------------------------------------------------------------------

header "Test 9 — invoice.created"
info "Draft invoice receives custom description and metadata (soft failure OK)"

RESPONSE=$(send_event "{
  \"type\": \"invoice.created\",
  \"id\": \"evt_test_invoice_created_001\",
  \"data\": {
    \"object\": {
      \"id\": \"in_test_draft_001\",
      \"object\": \"invoice\",
      \"status\": \"draft\",
      \"customer\": \"$FAKE_CUSTOMER\",
      \"billing_reason\": \"subscription_cycle\"
    }
  }
}")

check_received "$RESPONSE" "invoice.created"
# Note: the invoice.update call to Stripe will fail in dev since in_test_draft_001
# is not a real invoice. The handler logs a warning and continues — that is correct.

# ---------------------------------------------------------------------------
# Stripe CLI trigger tests (if CLI available)
# ---------------------------------------------------------------------------

if [[ -n "$STRIPE_CLI" ]]; then
  header "Stripe CLI Trigger Tests"
  info "Using: $STRIPE_CLI"

  SK="${STRIPE_SECRET_KEY:-${STRIPE_SECRET_KEY:-}}"
  if [[ -z "$SK" ]]; then
    SK=$(grep 'STRIPE_SECRET_KEY=' .env.local 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  fi

  if [[ -z "$SK" ]]; then
    warn "STRIPE_SECRET_KEY not found — skipping CLI trigger tests"
  else
    # Smoke test: verify CLI can reach the Stripe API
    if $STRIPE_CLI customers list --api-key "$SK" --limit 1 &>/dev/null; then
      pass "Stripe CLI can reach the API"

      info "Triggering customer.created via CLI..."
      if $STRIPE_CLI trigger customer.created \
          --api-key "$SK" &>/dev/null; then
        pass "stripe trigger customer.created — OK"
      else
        warn "stripe trigger customer.created — failed (non-critical)"
      fi
    else
      warn "Stripe CLI cannot reach the API — check STRIPE_SECRET_KEY"
    fi
  fi
else
  header "Stripe CLI Trigger Tests"
  warn "Skipped — Stripe CLI not found"
  info "Install: curl -sL https://github.com/stripe/stripe-cli/releases/download/v1.40.7/stripe_1.40.7_linux_x86_64.tar.gz | tar -xz -C /tmp/"
  info "Then run:  /tmp/stripe listen --api-key sk_test_... --forward-to $WEBHOOK_URL"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

header "Results"

TOTAL_TESTS=9
PASSED=$((TOTAL_TESTS - FAILURES))

if [[ $FAILURES -eq 0 ]]; then
  echo -e "\n  ${GREEN}${BOLD}All $TOTAL_TESTS tests passed.${RESET}\n"
else
  echo -e "\n  ${RED}${BOLD}$FAILURES of $TOTAL_TESTS tests failed.${RESET}\n"
  exit 1
fi
