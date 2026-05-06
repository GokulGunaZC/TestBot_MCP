/**
 * Evidence bundler — for every failed test, assemble the triage evidence bundle
 * the classifier and the two-hypothesis AI prompt both need:
 *
 *   - TraceEvidence (trace-parser output)
 *   - Test source — the exact `test(...)` block from the generated spec
 *   - AC text — parsed out of the [REQ:F#.S#.AC#] tag in the test title, looked
 *     up in parsed-prd.json
 *   - Exploration route entry — the ExplorationArtifact route matching the
 *     failing URL (so the classifier can check whether a selector was
 *     hallucinated vs. genuinely removed from the app)
 *   - Tier + role — inferred from test.projectName
 *
 * Credential hygiene: we deny-list `auth-state*` paths, never emit login-URL
 * request bodies, and redact `password=*` / `token=*` / `Authorization:`
 * substrings from every string field.
 *
 * Never throws — on any failure we emit best-effort evidence and continue.
 */

const fs = require('fs');
const path = require('path');

const { parseTrace, resolveTracePath } = require('./trace-parser');

const MAX_TEST_SOURCE_BYTES = 2500;
const MAX_EVIDENCE_BYTES = 4000;
const DENY_PATHS = [/auth-state[_-][^/]*\.json/i];

const REDACT_PATTERNS = [
  /password=[^&\s"']+/gi,
  /token=[^&\s"']+/gi,
  /(authorization:\s*)(bearer\s+)?[^\s"']+/gi,
  /api[_-]?key=[^&\s"']+/gi,
];

function redact(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const re of REDACT_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

function safePathIsForbidden(p) {
  const str = String(p || '');
  return DENY_PATHS.some((re) => re.test(str));
}

function readFileSafe(absPath) {
  try {
    if (!absPath || !fs.existsSync(absPath)) return null;
    if (safePathIsForbidden(absPath)) return null;
    return fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Extract the specific `test(...)` block matching the given title from the
 * full spec source. We handle both single- and backtick-quoted titles.
 */
function extractTestBlock(source, title) {
  if (!source || !title) return null;
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`test\\s*\\(\\s*(?:['"\`])${escaped}(?:['"\`])[\\s\\S]*?\\n\\}\\s*\\)`, 'm');
  const match = source.match(re);
  if (!match) return null;
  const block = match[0];
  if (block.length > MAX_TEST_SOURCE_BYTES) {
    return block.slice(0, MAX_TEST_SOURCE_BYTES) + '\n/* … truncated … */';
  }
  return block;
}

/**
 * Pull out the REQ tag (F#.S#.AC#) from a test title, then look up the
 * matching AC text in parsed-prd.json.
 */
function findAcceptanceCriterion(title, parsedPRD) {
  if (!title || !parsedPRD) return null;
  const tagMatch = /\[REQ:([A-Za-z0-9.]+)\]/.exec(title);
  if (!tagMatch) return null;
  const fullTag = tagMatch[1];

  const features = Array.isArray(parsedPRD.features) ? parsedPRD.features : [];
  for (const f of features) {
    const stories = Array.isArray(f?.userStories) ? f.userStories : [];
    for (const s of stories) {
      const acs = Array.isArray(s?.acceptanceCriteria) ? s.acceptanceCriteria : [];
      for (const ac of acs) {
        const candidate = ac?.tag || ac?.reqTag || ac?.id || null;
        if (candidate && String(candidate).endsWith(fullTag)) {
          return {
            tag: String(candidate),
            text: redact(String(ac.text || ac.description || '')).slice(0, 600),
            authRequired: !!ac.authRequired,
            roleHint: ac.roleHint || null,
            kind: ac.kind || null,
          };
        }
      }
    }
  }

  // Fall back to partial-match — spec might have been generated against a
  // stale PRD. Better to return "unknown AC" than nothing at all.
  return { tag: fullTag, text: null, unmatched: true };
}

/**
 * Match a failing URL against the exploration artifact's known routes so the
 * classifier can decide "was this selector ever seen by exploration?"
 */
function findExplorationRoute(url, explorationArtifact) {
  if (!url || !explorationArtifact) return null;
  const routes = Array.isArray(explorationArtifact.routes) ? explorationArtifact.routes : [];
  if (routes.length === 0) return null;

  let cleanUrl = url;
  try {
    cleanUrl = new URL(url).pathname || url;
  } catch {
    // pattern match on raw string
  }

  const exact = routes.find((r) => r?.path === cleanUrl || r?.url === url);
  if (exact) return summariseRoute(exact);

  const prefix = routes.find((r) => typeof r?.path === 'string' && cleanUrl.startsWith(r.path));
  if (prefix) return summariseRoute(prefix);

  return null;
}

function summariseRoute(route) {
  return {
    path: route?.path || route?.url || null,
    selectors: Array.isArray(route?.elements)
      ? route.elements.slice(0, 24).map((el) => el?.selector || el?.testId || el?.text || '').filter(Boolean)
      : [],
    keyFlows: Array.isArray(route?.keyFlows) ? route.keyFlows.slice(0, 6) : [],
  };
}

/**
 * Read parsed-prd.json and exploration-artifact.json from the run's status
 * directory (written earlier in the pipeline).
 */
function loadRunContext(projectPath) {
  const statusDir = path.join(projectPath || process.cwd(), '.healix');
  return {
    parsedPRD: loadJson(path.join(statusDir, 'parsed-prd.json')),
    explorationArtifact: loadJson(path.join(statusDir, 'exploration-artifact.json')),
  };
}

function loadJson(absPath) {
  try {
    if (!fs.existsSync(absPath)) return null;
    if (safePathIsForbidden(absPath)) return null;
    return JSON.parse(fs.readFileSync(absPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Infer tier + role from a Playwright project name.
 *   tierA-public       → { tier: 'tierA-public', role: null }
 *   tierB-auth-admin   → { tier: 'tierB-auth-admin', role: 'admin' }
 *   tierC-backend      → { tier: 'tierC-backend', role: null }
 */
function resolveTierAndRole(projectName) {
  const str = String(projectName || '').toLowerCase();
  if (!str) return { tier: null, role: null };
  const roleMatch = /tierb-auth-([a-z0-9_-]+)/.exec(str);
  if (roleMatch) return { tier: str, role: roleMatch[1] };
  if (str.startsWith('tiera')) return { tier: str, role: null };
  if (str.startsWith('tierb')) return { tier: str, role: null };
  if (str.startsWith('tierc')) return { tier: str, role: null };
  return { tier: str, role: null };
}

function sizeOf(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value || {}), 'utf-8');
  } catch {
    return 0;
  }
}

/**
 * Trim an evidence object to the size cap. We drop the lowest-signal fields
 * first (console trail, then network trail, then DOM sample) so the highest-
 * value fields (failedAction, testSource, AC) survive.
 */
function clampEvidenceSize(evidence) {
  if (!evidence) return evidence;
  const bytes = () => sizeOf(evidence);

  if (bytes() > MAX_EVIDENCE_BYTES && evidence?.trace?.consoleAtFailure?.length) {
    evidence.trace.consoleAtFailure = evidence.trace.consoleAtFailure.slice(0, 3);
  }
  if (bytes() > MAX_EVIDENCE_BYTES && evidence?.trace?.networkAtFailure?.length) {
    evidence.trace.networkAtFailure = evidence.trace.networkAtFailure.slice(0, 5);
  }
  if (bytes() > MAX_EVIDENCE_BYTES && evidence?.trace?.domAtFailure?.bodyTextSample) {
    evidence.trace.domAtFailure.bodyTextSample = evidence.trace.domAtFailure.bodyTextSample.slice(0, 400);
  }
  if (bytes() > MAX_EVIDENCE_BYTES && typeof evidence?.testSource === 'string') {
    evidence.testSource = evidence.testSource.slice(0, 1200) + '\n/* truncated */';
  }
  return evidence;
}

/**
 * Build a FailureEvidence bundle for a single failed test.
 */
async function bundleOne({ failure, test, projectPath, parsedPRD, explorationArtifact }) {
  const title = test?.title || failure?.testName || '';
  const file = test?.file || failure?.file || null;
  const specAbs = file ? path.isAbsolute(file) ? file : path.join(projectPath || process.cwd(), file) : null;
  const specSource = readFileSafe(specAbs);
  const testBlock = extractTestBlock(specSource, title);
  const tracePath = resolveTracePath(failure?.artifacts || test?.artifacts, projectPath);
  const trace = tracePath ? await parseTrace(tracePath) : null;
  const ac = findAcceptanceCriterion(title, parsedPRD);
  const failedUrl = trace?.failedAction?.url || null;
  const route = findExplorationRoute(failedUrl, explorationArtifact);
  const { tier, role } = resolveTierAndRole(test?.projectName || failure?.projectName);

  const errorMessage = redact(failure?.error?.message || test?.error?.message || '').slice(0, 600);
  const stack = redact(failure?.error?.stack || test?.error?.stack || '').slice(0, 1200);

  const bundle = {
    kind: 'test',
    testName: title,
    file,
    tier,
    role,
    status: test?.status || failure?.status || 'failed',
    duration: Number(test?.duration || failure?.duration || 0) || 0,
    error: { message: errorMessage, stack },
    testSource: testBlock,
    acceptanceCriterion: ac,
    explorationRoute: route,
    trace: trace ? {
      failedAction: trace.failedAction,
      domAtFailure: trace.domAtFailure,
      networkAtFailure: trace.networkAtFailure,
      consoleAtFailure: trace.consoleAtFailure,
      parseError: trace.parseError || null,
    } : { parseError: 'trace_not_available' },
  };

  return clampEvidenceSize(bundle);
}

/**
 * Build evidence bundles for all failures in a run. Safe to call with an
 * empty array — returns [].
 *
 * Also writes each bundle to `healix-reports/.runs/{runId}/failures/{idx}.json`
 * for offline inspection (best-effort — we never throw if the dir doesn't
 * exist).
 */
async function bundleFailures({ failures = [], tests = [], projectPath, runId }) {
  if (!Array.isArray(failures) || failures.length === 0) {
    return { bundles: [], skipped: 0 };
  }

  const { parsedPRD, explorationArtifact } = loadRunContext(projectPath);
  const testByTitle = new Map();
  for (const t of tests) {
    if (t?.title) testByTitle.set(t.title, t);
  }

  const bundles = [];
  let skipped = 0;

  for (const failure of failures) {
    try {
      const test = testByTitle.get(failure?.testName || '') || failure;
      const bundle = await bundleOne({ failure, test, projectPath, parsedPRD, explorationArtifact });
      bundles.push(bundle);
    } catch (err) {
      skipped += 1;
      bundles.push({
        kind: 'test',
        testName: failure?.testName || 'unknown',
        file: failure?.file || null,
        error: { message: `evidence_bundler_failed: ${err?.message || 'unknown'}` },
        bundleError: true,
      });
    }
  }

  // Persist bundles for debugging / offline training. Non-fatal on error.
  try {
    if (projectPath && runId) {
      const outDir = path.join(projectPath, 'healix-reports', '.runs', String(runId), 'failures');
      fs.mkdirSync(outDir, { recursive: true });
      bundles.forEach((b, idx) => {
        try {
          fs.writeFileSync(path.join(outDir, `${idx}.json`), JSON.stringify(b, null, 2), 'utf-8');
        } catch {
          // ignore single-file write failures
        }
      });
    }
  } catch {
    // best-effort; never fail the pipeline because we couldn't persist evidence
  }

  return { bundles, skipped };
}

module.exports = {
  bundleFailures,
  bundleOne, // exported for unit tests
  extractTestBlock,
  findAcceptanceCriterion,
  findExplorationRoute,
  resolveTierAndRole,
  redact,
};
