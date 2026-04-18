'use strict';

/**
 * Phase T7 — MCP → Cursor agent handoff.
 *
 * Given a persisted Healix report (plus the test files that were run), produce
 * a structured response the Cursor agent can act on WITHOUT re-understanding
 * the dashboard UI. The response sorts failures into four actionable buckets
 * and a machine-readable ACTION PLAN.
 *
 * Four buckets:
 *   - auto_apply            — test_is_wrong, conf ≥ 0.85, patch re-verified
 *                             against disk; safe for the agent to apply.
 *   - surface_for_approval  — test_is_wrong with conf < 0.85, OR ambiguous,
 *                             OR any patch that failed re-verification.
 *   - app_regressions       — app_is_wrong; never auto-edited, always surfaced.
 *   - environment_issues    — flaky, infra, auth — suggest retries.
 *
 * Plus pipeline_error when the run never produced tests (T1).
 *
 * Pre-apply guardrail (re-verified here, not trusted from the model):
 *   1. oldCode must appear verbatim in the test file on disk (handles
 *      hallucinated line numbers).
 *   2. Patched newCode must still contain [REQ:...] tag.
 *   3. Patched test source must still contain ≥1 expect( call.
 *   4. Env var HEALIX_AUTO_APPLY_TEST_PATCHES=false forces every entry
 *      into surface_for_approval regardless of confidence.
 */

const fs = require('node:fs');
const path = require('node:path');
const { buildRemediationBlock, formatRemediationBlock } = require('./error-remediations');

const AUTO_APPLY_CONFIDENCE_FLOOR = 0.85;
const REQUIREMENT_TAG_REGEX = /\[REQ:[^\]]+\]/;
const EXPECT_CALL_REGEX = /\bexpect\s*\(/;

function readTestSourceSafe(projectPath, relativeFile) {
  if (!projectPath || !relativeFile) return null;
  try {
    const abs = path.isAbsolute(relativeFile)
      ? relativeFile
      : path.join(projectPath, relativeFile);
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}

function verifyPatchAgainstDisk({ patch, testSource }) {
  if (!patch || typeof patch !== 'object') {
    return { ok: false, reason: 'no_patch' };
  }
  const { oldCode, newCode } = patch;
  if (typeof newCode !== 'string' || !newCode.length) {
    return { ok: false, reason: 'patch_missing_newCode' };
  }
  if (testSource === null || testSource === undefined) {
    return { ok: false, reason: 'test_source_unavailable' };
  }
  if (typeof oldCode === 'string' && oldCode.length > 0 && !testSource.includes(oldCode)) {
    return { ok: false, reason: 'oldCode_not_in_source' };
  }
  // Simulate the patched file to verify guardrails still hold.
  const patched = typeof oldCode === 'string' && oldCode.length > 0
    ? testSource.replace(oldCode, newCode)
    : testSource + '\n' + newCode;
  if (!REQUIREMENT_TAG_REGEX.test(patched)) {
    return { ok: false, reason: 'requirement_tag_removed' };
  }
  if (!EXPECT_CALL_REGEX.test(patched)) {
    return { ok: false, reason: 'no_expect_call_remaining' };
  }
  return { ok: true, reason: 'verified' };
}

function autoApplyKillSwitchOn() {
  const raw = String(process.env.HEALIX_AUTO_APPLY_TEST_PATCHES ?? '').toLowerCase();
  return raw === 'false' || raw === '0' || raw === 'off' || raw === 'no';
}

function bundleFromReport(report, index) {
  const failures = Array.isArray(report.failures) ? report.failures : [];
  return failures[index] ?? null;
}

function verdictFromReport(report, index) {
  const verdicts = Array.isArray(report.classifierVerdicts) ? report.classifierVerdicts : [];
  const bundle = bundleFromReport(report, index);
  if (bundle?.classifierVerdict) return bundle.classifierVerdict;
  if (verdicts[index]) return verdicts[index];
  return null;
}

function aiAnalysisForBundle(aiAnalysis, bundle) {
  if (!Array.isArray(aiAnalysis) || !bundle?.testName) return null;
  return aiAnalysis.find((item) => {
    const name = item?.testName ?? item?.test ?? item?.test_name;
    return typeof name === 'string' && name.trim() === bundle.testName.trim();
  }) ?? null;
}

function dashboardDeepLink(dashboardUrl, testRunId, failureKey) {
  if (!dashboardUrl || !testRunId) return null;
  const base = dashboardUrl.replace(/\/+$/, '');
  return `${base}/test-run/${testRunId}#failure-${encodeURIComponent(failureKey || '')}`;
}

function summarizeStats(report) {
  const stats = report?.stats ?? {};
  return {
    total: Number(stats.total ?? 0),
    passed: Number(stats.passed ?? 0),
    failed: Number(stats.failed ?? 0),
    skipped: Number(stats.skipped ?? 0),
    flaky: Number(stats.flaky ?? 0),
  };
}

/**
 * Build the structured agent response.
 *
 * @param {object} opts
 * @param {object} opts.report              Parsed Healix report JSON.
 * @param {string} [opts.projectPath]       Project root, used to re-read test files on disk.
 * @param {string} [opts.dashboardUrl]      Healix dashboard base URL for deep links.
 * @param {string} [opts.testRunId]         DB-side test_run id for deep links.
 * @param {Array<object>} [opts.aiAnalysis] AI analyses keyed by testName (if any).
 * @returns {{ summary, verdicts, dashboardUrl, actionPlan }}
 */
function buildAgentResponse({ report, projectPath = null, dashboardUrl = null, testRunId = null, aiAnalysis = [] }) {
  const killSwitch = autoApplyKillSwitchOn();
  const summary = summarizeStats(report);
  if (report?.pipelineError) summary.pipelineError = true;

  const out = {
    auto_apply: [],
    surface_for_approval: [],
    app_regressions: [],
    environment_issues: [],
  };

  const failures = Array.isArray(report?.failures) ? report.failures : [];
  failures.forEach((bundle, idx) => {
    const verdict = verdictFromReport(report, idx);
    if (!bundle || !verdict) return;

    const ai = aiAnalysisForBundle(aiAnalysis, bundle);
    const mergedVerdict = ai?.verdict ?? verdict.verdict;
    const confidence = Number(ai?.verdictConfidence ?? verdict.confidence ?? 0);
    const reason = ai?.reason ?? verdict.reason ?? 'no_reason';
    const evidenceUrl = dashboardDeepLink(dashboardUrl, testRunId, bundle.testName);
    const patch = ai?.suggestedPatch ?? null;

    if (mergedVerdict === 'app_is_wrong') {
      out.app_regressions.push({
        testName: bundle.testName,
        file: bundle.file,
        tier: bundle.tier,
        reason,
        affectedUrl: bundle?.trace?.failedAction?.url ?? null,
        evidenceUrl,
      });
      return;
    }

    if (mergedVerdict === 'environment') {
      out.environment_issues.push({
        testName: bundle.testName,
        file: bundle.file,
        reason,
        evidenceUrl,
      });
      return;
    }

    if (mergedVerdict === 'ambiguous' || mergedVerdict === null || mergedVerdict === undefined) {
      out.surface_for_approval.push({
        testName: bundle.testName,
        file: bundle.file,
        verdict: mergedVerdict ?? 'ambiguous',
        confidence,
        reason,
        evidenceUrl,
      });
      return;
    }

    // test_is_wrong — decide auto_apply vs surface_for_approval
    const testSource = bundle.testSource ?? readTestSourceSafe(projectPath, bundle.file);
    const guard = verifyPatchAgainstDisk({ patch, testSource });
    const eligibleByConfidence = confidence >= AUTO_APPLY_CONFIDENCE_FLOOR;

    if (!killSwitch && eligibleByConfidence && guard.ok) {
      out.auto_apply.push({
        testName: bundle.testName,
        file: bundle.file,
        tier: bundle.tier,
        reason,
        confidence,
        patch: {
          lineStart: patch.lineStart ?? null,
          lineEnd: patch.lineEnd ?? null,
          oldCode: patch.oldCode ?? '',
          newCode: patch.newCode,
        },
        evidenceUrl,
      });
    } else {
      out.surface_for_approval.push({
        testName: bundle.testName,
        file: bundle.file,
        verdict: mergedVerdict,
        confidence,
        reason,
        downgradeReason: killSwitch
          ? 'kill_switch'
          : (!eligibleByConfidence ? 'confidence_below_floor' : guard.reason),
        evidenceUrl,
      });
    }
  });

  const response = {
    summary,
    verdicts: out,
    dashboardUrl: dashboardUrl && testRunId
      ? `${dashboardUrl.replace(/\/+$/, '')}/test-run/${testRunId}`
      : null,
  };

  if (report?.pipelineError) {
    const pe = report.pipelineError;
    const remediation = buildRemediationBlock({
      errorCode: pe.errorCode,
      fallbackMessage: pe.userFacingMessage,
    });
    response.verdicts.pipeline_error = {
      stage: pe.stage ?? null,
      reason: pe.reason ?? null,
      errorCode: pe.errorCode ?? null,
      stderrPreview: typeof pe.stderr === 'string' ? pe.stderr.slice(0, 2000) : null,
      generatedSpecCount: pe.generatedSpecCount ?? null,
      userFacingMessage: pe.userFacingMessage ?? null,
      remediation,
      dashboardUrl: response.dashboardUrl,
    };
  }

  response.actionPlan = formatActionPlan(response);
  return response;
}

function formatActionPlan(resp) {
  const lines = ['## ACTION PLAN'];

  if (resp.verdicts.auto_apply.length > 0) {
    lines.push('', '### Auto-apply (safe, high-conf test bugs):');
    resp.verdicts.auto_apply.forEach((a, i) => {
      const range = a.patch.lineStart ? `:${a.patch.lineStart}${a.patch.lineEnd ? '-' + a.patch.lineEnd : ''}` : '';
      lines.push(`${i + 1}. Patch ${a.file}${range}`);
      if (a.patch.oldCode) lines.push(`   Replace: ${truncate(a.patch.oldCode, 140)}`);
      lines.push(`   With:    ${truncate(a.patch.newCode, 140)}`);
      lines.push(`   Reason:  ${a.reason}`);
    });
  }

  if (resp.verdicts.surface_for_approval.length > 0) {
    lines.push('', '### Please review (ambiguous or low-confidence):');
    resp.verdicts.surface_for_approval.forEach((s) => {
      const tail = s.evidenceUrl ? ` Open ${s.evidenceUrl} before deciding.` : '';
      lines.push(`- ${s.testName} — AI verdict '${s.verdict}' (${(s.confidence * 100).toFixed(0)}%).${tail}`);
      if (s.downgradeReason) lines.push(`  downgraded: ${s.downgradeReason}`);
    });
  }

  if (resp.verdicts.app_regressions.length > 0) {
    lines.push('', '### App regressions (DO NOT auto-edit app source):');
    resp.verdicts.app_regressions.forEach((a) => {
      const at = a.affectedUrl ? ` (${a.affectedUrl})` : '';
      const link = a.evidenceUrl ? ` See ${a.evidenceUrl}.` : '';
      lines.push(`- ${a.testName} — ${a.reason}${at}.${link}`);
    });
  }

  if (resp.verdicts.environment_issues.length > 0) {
    lines.push('', '### Environment issues:');
    resp.verdicts.environment_issues.forEach((e) => {
      lines.push(`- ${e.testName} — ${e.reason}`);
    });
  }

  if (resp.verdicts.pipeline_error) {
    const pe = resp.verdicts.pipeline_error;
    lines.push('', '### Pipeline error:');
    lines.push(`- stage: ${pe.stage}, reason: ${pe.reason}, errorCode: ${pe.errorCode || 'UNCLASSIFIED'}`);
    if (pe.userFacingMessage) lines.push(`  ${pe.userFacingMessage}`);
    if (pe.dashboardUrl) lines.push(`  Dashboard: ${pe.dashboardUrl}`);
    if (pe.remediation) {
      lines.push('');
      lines.push(formatRemediationBlock(pe.remediation));
    }
  }

  if (resp.dashboardUrl) {
    lines.push('', `Dashboard: ${resp.dashboardUrl}`);
  }

  return lines.join('\n');
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1) + '…';
}

module.exports = {
  buildAgentResponse,
  verifyPatchAgainstDisk,
  autoApplyKillSwitchOn,
  AUTO_APPLY_CONFIDENCE_FLOOR,
};
