'use strict';

/**
 * Regression tests for healix_check_run_status.
 *
 * Motivation: prior to this tool the Cursor agent went idle after
 * healix_test_my_app returned the configUrl — it had no way to know the
 * background pipeline had finished (or crashed). Without a poller, users saw
 * "agent done" while the run was still executing, and pipeline-level errors
 * (the 2026-04-18 pm-app screenshot) never reached the agent at all.
 *
 * This file locks in the contract: given a status.json on disk, the handler
 * must return `isTerminal: false` (+ poll-again instructions) for in-flight
 * runs, and `isTerminal: true` (+ action plan / error summary) for terminal
 * phases. It also must fail cleanly when the runId is missing or bogus.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TestBotMCP = require('../src/index');

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-check-status-'));
  return dir;
}

function writeStatus(projectPath, runId, payload) {
  const dir = path.join(projectPath, 'healix-reports', '.runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'status.json');
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

function newHandler() {
  const server = Object.create(TestBotMCP.prototype);
  server.validateApiKey = async () => true;
  server.trackToolInvocation = () => Date.now();
  server.trackToolResult = () => null;
  server.emitTelemetry = () => null;
  server.loadLatestHealixReport = TestBotMCP.prototype.loadLatestHealixReport.bind(server);
  return server;
}

function parseResponse(result) {
  assert.ok(result?.content?.[0]?.text, 'handler returned no text content');
  const raw = result.content[0].text;
  const jsonChunk = raw.includes('---\n\n') ? raw.split('---\n\n').pop() : raw;
  return JSON.parse(jsonChunk);
}

test('missing runId → isError with actionable message', async () => {
  const h = newHandler();
  const result = await h.handleCheckRunStatus({ projectPath: tempProject() });
  assert.equal(result.isError, true);
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.success, false);
  assert.match(parsed.error, /runId/i);
});

test('unknown runId → RUN_NOT_FOUND, isTerminal:false', async () => {
  const h = newHandler();
  const result = await h.handleCheckRunStatus({ projectPath: tempProject(), runId: 'bogus-run-id' });
  assert.equal(result.isError, true);
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.error, 'RUN_NOT_FOUND');
  assert.equal(parsed.isTerminal, false);
});

test('running phase → isTerminal:false, instructs agent to poll again', async () => {
  const h = newHandler();
  const projectPath = tempProject();
  const runId = 'run-1';
  writeStatus(projectPath, runId, {
    runId, phase: 'executing_tests', message: 'Tier A running',
  });
  const result = await h.handleCheckRunStatus({ projectPath, runId });
  const parsed = parseResponse(result);
  assert.equal(parsed.isTerminal, false);
  assert.equal(parsed.phase, 'executing_tests');
  assert.match(parsed.agentInstructions, /call healix_check_run_status again/i);
  assert.match(parsed.agentInstructions, /15 seconds/i);
});

test('awaiting_config_ui (also non-terminal) → poll-again instructions', async () => {
  const h = newHandler();
  const projectPath = tempProject();
  const runId = 'run-2';
  writeStatus(projectPath, runId, {
    runId, phase: 'awaiting_config_ui', message: 'Waiting for config form',
    configUrl: 'http://localhost:3100/config/run-2',
  });
  const result = await h.handleCheckRunStatus({ projectPath, runId });
  const parsed = parseResponse(result);
  assert.equal(parsed.isTerminal, false);
  assert.equal(parsed.configUrl, 'http://localhost:3100/config/run-2');
});

test('completed without report → isTerminal:true, share-dashboard instruction', async () => {
  const h = newHandler();
  const projectPath = tempProject();
  const runId = 'run-3';
  writeStatus(projectPath, runId, {
    runId, phase: 'completed', message: 'Run complete',
    dashboardUrl: 'http://localhost:3000/test-run/abc',
  });
  const result = await h.handleCheckRunStatus({ projectPath, runId });
  const parsed = parseResponse(result);
  assert.equal(parsed.isTerminal, true);
  assert.equal(parsed.phase, 'completed');
  assert.equal(parsed.dashboardUrl, 'http://localhost:3000/test-run/abc');
  assert.match(parsed.agentInstructions, /dashboardUrl|dashboard/i);
});

test('error phase → isTerminal:true, relay-error instruction with errorCode', async () => {
  const h = newHandler();
  const projectPath = tempProject();
  const runId = 'run-4';
  writeStatus(projectPath, runId, {
    runId, phase: 'error',
    message: 'Playwright execution failed',
    errorCode: 'FIXTURE_MODULE_TYPE_MISMATCH',
    dashboardUrl: 'http://localhost:3000/test-run/xyz',
  });
  const result = await h.handleCheckRunStatus({ projectPath, runId });
  const parsed = parseResponse(result);
  assert.equal(parsed.isTerminal, true);
  assert.equal(parsed.errorCode, 'FIXTURE_MODULE_TYPE_MISMATCH');
  assert.match(parsed.agentInstructions, /error|dashboard|pipeline_error/i);
});

test('error phase attaches structured remediation block for fixable errorCode', async () => {
  // The Cursor agent reads `remediation.fixable` to decide whether to
  // auto-remediate or surface to the user. This test pins that contract.
  const h = newHandler();
  const projectPath = tempProject();
  const runId = 'run-fix';
  writeStatus(projectPath, runId, {
    runId, phase: 'error',
    message: 'Cannot reach Healix webapp at http://localhost:3000',
    errorCode: 'WEBAPP_UNREACHABLE',
    dashboardUrl: 'http://localhost:3000/test-run/xyz',
  });
  const result = await h.handleCheckRunStatus({ projectPath, runId });
  const parsed = parseResponse(result);
  assert.equal(parsed.errorCode, 'WEBAPP_UNREACHABLE');
  assert.ok(parsed.remediation, 'must include a remediation block');
  assert.equal(parsed.remediation.fixable, true);
  assert.equal(parsed.remediation.errorCode, 'WEBAPP_UNREACHABLE');
  assert.ok(Array.isArray(parsed.remediation.remediationSteps) && parsed.remediation.remediationSteps.length > 0);
  assert.ok(parsed.remediation.retry?.tool);
  // Agent instructions must tell the agent NOT to hand back to the user.
  assert.match(parsed.agentInstructions, /auto-fixable|do NOT hand/i);
  // Raw text content should include the markdown remediation block above the JSON.
  const raw = result.content[0].text;
  assert.match(raw, /## AGENT REMEDIATION/);
  assert.match(raw, /npm run dev/);
});

test('error phase with non-fixable errorCode still carries remediation, but fixable:false', async () => {
  const h = newHandler();
  const projectPath = tempProject();
  const runId = 'run-nofix';
  writeStatus(projectPath, runId, {
    runId, phase: 'error',
    message: 'Dev server never became reachable',
    errorCode: 'SERVER_START_TIMEOUT',
    dashboardUrl: 'http://localhost:3000/test-run/xyz',
  });
  const result = await h.handleCheckRunStatus({ projectPath, runId });
  const parsed = parseResponse(result);
  assert.equal(parsed.remediation?.fixable, false);
  assert.match(parsed.agentInstructions, /user input|Surface/i);
});

test('error phase with unknown errorCode still returns a fallback remediation block', async () => {
  const h = newHandler();
  const projectPath = tempProject();
  const runId = 'run-unknown';
  writeStatus(projectPath, runId, {
    runId, phase: 'error',
    message: 'Something totally new broke',
    errorCode: 'BRAND_NEW_UNCLASSIFIED_CODE',
  });
  const result = await h.handleCheckRunStatus({ projectPath, runId });
  const parsed = parseResponse(result);
  assert.ok(parsed.remediation);
  assert.equal(parsed.remediation.fixable, false);
  assert.equal(parsed.remediation.errorCode, 'BRAND_NEW_UNCLASSIFIED_CODE');
});

test('corrupt status.json → isTerminal:false with transient_read_error, never throws', async () => {
  const h = newHandler();
  const projectPath = tempProject();
  const runId = 'run-5';
  const dir = path.join(projectPath, 'healix-reports', '.runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), '{not json');
  const result = await h.handleCheckRunStatus({ projectPath, runId });
  const parsed = parseResponse(result);
  assert.equal(parsed.isTerminal, false);
  assert.equal(parsed.phase, 'transient_read_error');
  assert.match(parsed.agentInstructions, /again/i);
});
