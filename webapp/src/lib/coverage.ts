// ─── Coverage Intelligence ────────────────────────────────────────────────────
// Shared server + client module.  No React dependencies.

export interface CoverageMetrics {
  coverageScore: number
  functionalCoverage: number
  totalSuites: number
  suitesWithPass: number
  apiCoverage: number | null
  apiTests: number
  apiPassed: number
  uiCoverage: number | null
  uiTests: number
  uiPassed: number
  happyTotal: number
  happyPassed: number
  edgeTotal: number
  edgePassed: number
  failureTotal: number
  failurePassed: number
}

// ─── Type classification helpers ─────────────────────────────────────────────

const API_CATS = new Set(['api_contract', 'api_auth', 'api_negative', 'api_stress'])
const FRONTEND_CATS = new Set(['ui_flow', 'form_validation', 'workflow_journey'])

const TYPE_KEYWORD_MAP: Record<string, string> = {
  smoke:         'smoke',
  sanity:        'smoke',
  e2e:           'e2e',
  integration:   'integration',
  regression:    'regression',
  workflow:      'workflow',
  journey:       'workflow',
  performance:   'performance',
  perf:          'performance',
  load:          'load',
  stress:        'stress',
  burst:         'stress',
  accessibility: 'accessibility',
  a11y:          'accessibility',
  visual:        'visual',
  snapshot:      'visual',
  contract:      'api',
  api:           'api',
  expansion:     'expansion',
  error:         'error',
  frontend:      'frontend',
  ui:            'frontend',
}

const FEATURE_SEGMENTS = new Set([
  'auth', 'user', 'users', 'home', 'page', 'pages', 'test', 'spec',
  'main', 'index', 'app', 'dashboard', 'settings', 'profile', 'login',
  'signup', 'register', 'admin', 'public', 'private', 'shared',
])

function extractCategory(name: string): string {
  const match = name.match(/\[CAT:([^\]]+)\]/i)
  if (!match) return 'uncategorized'
  return match[1].trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '')
}

export function extractMainType(name: string, suite: string): string {
  const fileBase = (suite || '')
    .toLowerCase()
    .replace(/\.spec\.(ts|js)$/i, '')
    .replace(/^(fallback|healix)[-_]/, '')

  const segments = fileBase.split(/[-_./\\]/)
  for (const seg of segments) {
    if (TYPE_KEYWORD_MAP[seg]) return TYPE_KEYWORD_MAP[seg]
  }

  const cat = extractCategory(name)
  if (API_CATS.has(cat)) return 'api'
  if (FRONTEND_CATS.has(cat)) return 'frontend'

  const firstMeaningful = segments.find(s => s.length > 1 && !FEATURE_SEGMENTS.has(s))
  if (firstMeaningful) return firstMeaningful

  return 'other'
}

// ─── Core computation ─────────────────────────────────────────────────────────

export interface TestInput {
  name: string
  suite: string
  status: string
}

export function computeCoverageMetrics(
  tests: TestInput[],
  passRate: number,
): CoverageMetrics {
  const isPass = (t: TestInput) =>
    ['passed', 'pass'].includes((t.status ?? '').toLowerCase())

  // Functional Coverage: % of suites with ≥1 passing test
  const suitesMap = new Map<string, { passed: number; total: number }>()
  for (const t of tests) {
    const key = t.suite || 'unknown'
    if (!suitesMap.has(key)) suitesMap.set(key, { passed: 0, total: 0 })
    const s = suitesMap.get(key)!
    s.total++
    if (isPass(t)) s.passed++
  }
  const totalSuites = suitesMap.size
  const suitesWithPass = Array.from(suitesMap.values()).filter(s => s.passed > 0).length
  const functionalCoverage =
    totalSuites > 0 ? Math.round((suitesWithPass / totalSuites) * 100) : 0

  // API Coverage
  const apiTests = tests.filter(t => extractMainType(t.name, t.suite) === 'api')
  const apiPassed = apiTests.filter(isPass).length
  const apiCoverage =
    apiTests.length > 0 ? Math.round((apiPassed / apiTests.length) * 100) : null

  // UI Coverage: frontend / smoke / e2e
  const uiTests = tests.filter(t =>
    ['frontend', 'smoke', 'e2e'].includes(extractMainType(t.name, t.suite)),
  )
  const uiPassed = uiTests.filter(isPass).length
  const uiCoverage =
    uiTests.length > 0 ? Math.round((uiPassed / uiTests.length) * 100) : null

  // Path Coverage
  const happyTests = tests.filter(t =>
    /success|happy.?path|should (show|display|render|load|navigate)|loads? (correctly|properly|successfully)/i.test(
      t.name,
    ),
  )
  const edgeTests = tests.filter(t =>
    /edge|boundary|empty|null|invalid|special.char|exceed|maximum|minimum/i.test(t.name),
  )
  const failureTests = tests.filter(t =>
    /fail|error|reject|denied|wrong|broken|missing|unavailable|not.found|unauthorized|forbidden/i.test(
      t.name,
    ),
  )

  // Weighted Coverage Score
  const coverageScore = Math.round(
    passRate * 0.35 +
    functionalCoverage * 0.30 +
    (uiCoverage ?? passRate) * 0.20 +
    (apiCoverage ?? passRate) * 0.15,
  )

  return {
    coverageScore,
    functionalCoverage,
    totalSuites,
    suitesWithPass,
    apiCoverage,
    apiTests: apiTests.length,
    apiPassed,
    uiCoverage,
    uiTests: uiTests.length,
    uiPassed,
    happyTotal: happyTests.length,
    happyPassed: happyTests.filter(isPass).length,
    edgeTotal: edgeTests.length,
    edgePassed: edgeTests.filter(isPass).length,
    failureTotal: failureTests.length,
    failurePassed: failureTests.filter(isPass).length,
  }
}
