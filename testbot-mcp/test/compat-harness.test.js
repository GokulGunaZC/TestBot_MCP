const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const AutoDetector = require('../src/auto-detector');
const ContextGatherer = require('../src/context-gatherer');
const {
  auditGeneratedTestQuality,
  pickAgentsForRun,
} = require('../src/pipeline-worker');

const repoRoot = path.resolve(__dirname, '..', '..');
const fixturesRoot = path.join(repoRoot, 'compat-fixtures');

function fixturePath(name) {
  return path.join(fixturesRoot, name);
}

test('compat fixtures expose expected framework and service metadata', async () => {
  const detector = new AutoDetector();
  const cases = [
    ['angular-public-app', { language: 'typescript', role: 'frontend', framework: 'angular', apiOnly: false }],
    ['react-vite-public-app', { language: 'typescript', role: 'frontend', framework: 'vite-react', apiOnly: false }],
    ['nextjs-typescript-fullstack', { language: 'typescript', role: 'fullstack', framework: 'next', apiOnly: false }],
    ['node-api', { language: 'javascript', role: 'backend', framework: 'express', apiOnly: true }],
    ['java-api', { language: 'java', role: 'backend', framework: 'gradle', apiOnly: true }],
    ['dotnet-shaped-api', { language: 'csharp', role: 'backend', framework: 'dotnet', apiOnly: true }],
  ];

  for (const [name, expected] of cases) {
    const detected = await detector.detect(fixturePath(name));
    assert.equal(detected.language, expected.language, `${name} language`);
    assert.equal(detected.apiOnly, expected.apiOnly, `${name} apiOnly`);
    assert.equal(detected.services[0].role, expected.role, `${name} role`);
    assert.equal(detected.services[0].framework, expected.framework, `${name} framework`);
  }
});

test('compat fixture contexts expose Angular routes and backend endpoints', async () => {
  const angularContext = await new ContextGatherer({
    projectPath: fixturePath('angular-public-app'),
    language: 'typescript',
    maxFiles: 80,
  }).gatherAutomatically();
  assert.ok(angularContext.pages.some((page) => page.path === '/intake'));
  assert.ok(angularContext.pages.some((page) => page.path === '/reports'));

  const javaContext = await new ContextGatherer({
    projectPath: fixturePath('java-api'),
    language: 'java',
    maxFiles: 80,
  }).gatherAutomatically();
  assert.ok(javaContext.apiEndpoints.some((endpoint) => endpoint.method === 'GET' && endpoint.path === '/api/inventory'));
  assert.ok(javaContext.apiEndpoints.some((endpoint) => endpoint.method === 'POST' && endpoint.path === '/api/inventory'));

  const csharpContext = await new ContextGatherer({
    projectPath: fixturePath('dotnet-shaped-api'),
    language: 'csharp',
    maxFiles: 80,
  }).gatherAutomatically();
  assert.ok(csharpContext.apiEndpoints.some((endpoint) => endpoint.method === 'GET' && endpoint.path === '/api/claims'));
  assert.ok(csharpContext.apiEndpoints.some((endpoint) => endpoint.method === 'POST' && endpoint.path === '/api/claims'));
});

test('compat fixture agent selection keeps frontend and backend surfaces separate', () => {
  assert.deepEqual(
    pickAgentsForRun('frontend', { framework: 'angular' }, {
      pages: [{ path: '/' }, { path: '/intake' }],
      workflows: [{ name: 'Delivery Intake' }],
      apiEndpoints: [{ method: 'GET', path: '/api/health', synthetic: true, source: 'healix_fallback' }],
    }),
    ['smoke', 'frontend', 'workflow'],
  );

  assert.deepEqual(
    pickAgentsForRun('backend', { apiOnly: true, framework: 'express' }, {
      apiEndpoints: [{ method: 'GET', path: '/api/work-orders' }],
    }),
    ['api'],
  );

  assert.deepEqual(
    pickAgentsForRun('both', { framework: 'vite-react' }, {
      pages: [{ path: '/' }],
      apiEndpoints: [{ method: 'GET', path: '/api/health', synthetic: true, source: 'healix_fallback' }],
    }),
    ['smoke', 'frontend'],
  );
});

test('quality audit rejects fallback or template generated specs for compatibility runs', () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'healix-compat-audit-'));
  try {
    const generatedDir = path.join(root, 'tests', 'generated');
    fs.mkdirSync(generatedDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'App.tsx'), "export function App(){ return <h1>Project Health Center</h1> }");
    fs.writeFileSync(path.join(generatedDir, 'fallback-frontend.spec.ts'), `
      import { test, expect } from '@playwright/test';
      test('fallback check', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('heading', { name: 'Project Health Center' })).toBeVisible();
      });
    `);

    const audit = auditGeneratedTestQuality({
      projectPath: root,
      testType: 'frontend',
      context: {
        pages: [{ path: '/', sourceFile: 'src/App.tsx' }],
        sourceContext: {
          files: [{ file: 'src/App.tsx', assertableText: ['Project Health Center'], routePaths: ['/'] }],
          assertableText: ['Project Health Center'],
          routePaths: ['/'],
        },
      },
    });
    assert.equal(audit.valid, false);
    assert.ok(audit.errors.includes('fallback_or_template_spec:fallback-frontend.spec.ts'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
