#!/usr/bin/env node
'use strict';

/**
 * Localhost smoke harness for the Healix generation pipeline.
 *
 * Drives the webapp generate-tests endpoints end-to-end against a real
 * project path and asserts that the full 5-agent fan-out produces at least
 * --min tests (default 50). Intended to be run after local changes to
 * generation plumbing so we catch regressions before the MCP pipeline
 * notices them.
 *
 * Prereqs:
 *   - webapp dev server reachable at $HEALIX_WEBAPP_URL (default http://localhost:3000).
 *   - $HEALIX_API_KEY set to a valid key.
 *   - A project path containing at least one source file so context capture works.
 *
 * Usage:
 *   node testbot-mcp/scripts/localhost-smoke.js --project /path/to/app --min 50
 */

const path = require('node:path');
const fs = require('node:fs');

const AGENTS = ['smoke', 'frontend', 'api', 'workflow', 'error'];

function parseArgs(argv) {
  const out = { project: null, min: 50, baseUrl: null, apiKey: null, profile: 'qa-max' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project') out.project = argv[++i];
    else if (a === '--min') out.min = Number(argv[++i]);
    else if (a === '--base-url') out.baseUrl = argv[++i];
    else if (a === '--api-key') out.apiKey = argv[++i];
    else if (a === '--profile') out.profile = argv[++i];
  }
  out.baseUrl = out.baseUrl || process.env.HEALIX_WEBAPP_URL || 'http://localhost:3000';
  out.apiKey = out.apiKey || process.env.HEALIX_API_KEY || '';
  return out;
}

function die(msg, code = 1) {
  process.stderr.write(`[localhost-smoke] ${msg}\n`);
  process.exit(code);
}

async function planGeneration({ baseUrl, apiKey, context }) {
  const res = await fetch(`${baseUrl}/api/generate-tests/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ context, projectInfo: context.projectInfo || {} }),
  });
  if (!res.ok) die(`plan failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

async function generateForAgent({ baseUrl, apiKey, agent, context, plan, profile }) {
  const res = await fetch(`${baseUrl}/api/generate-tests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      context,
      projectInfo: context.projectInfo || {},
      agentsAllowlist: [agent],
      agentPlanSlice: plan?.plan ?? plan ?? null,
      options: {
        coverageProfile: profile,
        strictAIGeneration: true,
        minGeneratedTests: 50,
        includeSmoke: true,
        includeWorkflows: true,
        includeErrorStates: true,
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  return {
    agent,
    ok: res.ok,
    status: res.status,
    files: Array.isArray(body.tests) ? body.tests : [],
    count: typeof body.count === 'number' ? body.count : 0,
    generationMeta: body.generationMeta ?? null,
  };
}

function buildMinimalContext(projectPath) {
  const pkgPath = path.join(projectPath, 'package.json');
  const pkg = fs.existsSync(pkgPath)
    ? JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    : {};
  return {
    projectInfo: {
      name: pkg.name || path.basename(projectPath),
      framework: pkg.dependencies?.next ? 'next' : pkg.dependencies?.react ? 'react' : 'unknown',
      projectPath,
    },
    pages: [{ path: '/' }],
    apiEndpoints: [],
    workflows: [],
    errorScenarios: [],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) die('missing --project /path/to/app');
  if (!args.apiKey) die('missing HEALIX_API_KEY (or pass --api-key)');
  if (!fs.existsSync(args.project)) die(`project path does not exist: ${args.project}`);

  const context = buildMinimalContext(args.project);
  process.stderr.write(`[localhost-smoke] planning against ${args.baseUrl}\n`);
  const plan = await planGeneration({ baseUrl: args.baseUrl, apiKey: args.apiKey, context });

  process.stderr.write(`[localhost-smoke] fanning out ${AGENTS.length} agents (profile=${args.profile})\n`);
  const started = Date.now();
  const results = await Promise.all(
    AGENTS.map((agent) =>
      generateForAgent({
        baseUrl: args.baseUrl,
        apiKey: args.apiKey,
        agent,
        context,
        plan,
        profile: args.profile,
      }),
    ),
  );
  const elapsedMs = Date.now() - started;

  let totalTests = 0;
  for (const r of results) {
    const q = r.generationMeta?.generationQuality;
    const tests = q?.totalTests ?? r.count;
    totalTests += tests;
    process.stdout.write(
      `  ${r.agent.padEnd(9)} http=${r.status} files=${r.files.length} tests=${tests}` +
        (r.generationMeta?.agentFailures?.length
          ? ` failures=${r.generationMeta.agentFailures.length}`
          : '') +
        '\n',
    );
  }

  const ok = totalTests >= args.min && results.every((r) => r.ok);
  process.stdout.write(
    `\n[localhost-smoke] total=${totalTests} min=${args.min} elapsed=${elapsedMs}ms ${ok ? 'PASS' : 'FAIL'}\n`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => die(err?.stack || err?.message || String(err)));
