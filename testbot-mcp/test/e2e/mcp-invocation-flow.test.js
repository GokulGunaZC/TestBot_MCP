const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TestbotMCPServer = require('../../src/index');
const ConfigUILauncher = require('../../src/config-ui-launcher');

function parseToolResponse(result) {
  return JSON.parse(result.content[0].text);
}

async function waitFor(checkFn, timeoutMs = 5000, intervalMs = 25) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = checkFn();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

test('MCP invocation flow opens config UI, accepts /api/config, and starts strict AI pipeline path', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbot-mcp-e2e-flow-'));
  const launcherPort = 55321;
  let capturedConfig = null;

  try {
    const subject = Object.create(TestbotMCPServer.prototype);
    subject.createAutoDetector = () => ({
      detect: async () => ({
        projectPath: tempDir,
        projectName: 'E2E Demo',
        language: 'javascript',
        ecosystem: 'node',
        baseURL: 'http://localhost:3000',
        port: 3000,
        startCommand: 'npm run dev',
      }),
    });

    subject.createConfigUILauncher = () => {
      const launcher = new ConfigUILauncher({ port: launcherPort, timeout: 5000 });
      launcher.openInBrowser = () => {};
      return launcher;
    };

    subject.runPipelineInBackground = (config, runId) => {
      capturedConfig = config;
      const statusFile = path.join(config.projectPath, 'testbot-reports', '.runs', runId, 'status.json');
      setTimeout(() => {
        subject.writeRunStatus(statusFile, {
          runId,
          phase: 'completed',
          message: 'Pipeline complete (stubbed for e2e test).',
          aiOnlyEnforced: config.strictAIGeneration !== false,
          generationMeta: {
            selectedGenerator: 'openai',
            fallbackUsed: false,
          },
          fallbackUsed: false,
        });
      }, 30);
    };

    const toolResult = await subject.handleTestMyApp({
      projectPath: tempDir,
      showConfigUI: true,
    });

    const payload = parseToolResponse(toolResult);
    assert.equal(payload.status, 'awaiting_configuration');
    assert.ok(payload.configUrl.includes('config-form.html'));
    assert.equal(payload.aiOnlyEnforced, true);

    const configOrigin = new URL(payload.configUrl).origin;
    const submitResponse = await fetch(`${configOrigin}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testType: 'both',
        scope: 'codebase',
        baseURL: 'http://localhost:3000',
        startCommand: 'npm run dev',
        generateTests: true,
        openDashboard: false,
        prd: {
          name: 'requirements.md',
          contentType: 'text/markdown',
          textContent: '# REQ-1\nUser can login',
        },
      }),
    });

    assert.equal(submitResponse.status, 200);

    const completed = await waitFor(() => {
      if (!fs.existsSync(payload.statusFile)) return null;
      const status = JSON.parse(fs.readFileSync(payload.statusFile, 'utf-8'));
      return status.phase === 'completed' ? status : null;
    });

    assert.equal(completed.phase, 'completed');
    assert.equal(capturedConfig.strictAIGeneration, true);
    assert.equal(capturedConfig.generationMode, 'openai-only');
    assert.equal(capturedConfig.aiOnlyEnforced, true);
    assert.ok(capturedConfig.prdFile);
    assert.ok(fs.existsSync(capturedConfig.prdFile));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
