#!/usr/bin/env node
/* eslint-disable no-console */

const path = require('path');
const fs = require('fs');
const TestbotMCPServer = require('../../src/index');

async function main() {
  const webappPath = '/Users/krishsharma/Desktop/QA_Final/webapp';
  if (!fs.existsSync(webappPath)) {
    throw new Error(`Webapp path does not exist: ${webappPath}`);
  }

  const server = new TestbotMCPServer();

  const result = await server.handleTestMyApp({
    projectPath: webappPath,
    showConfigUI: false,
    testType: 'both',
    strictAIGeneration: true,
    minGeneratedTests: 50,
    coverageProfile: 'qa-max',
    phaseMode: 'two-phase',
    generateTests: true,
    openDashboard: false,
  });

  const payload = JSON.parse(result.content[0].text);
  const statusFile = payload.statusFile;

  console.log(JSON.stringify({
    runId: payload.runId,
    status: payload.status,
    statusFile,
    aiOnlyEnforced: payload.aiOnlyEnforced,
  }, null, 2));

  const startedAt = Date.now();
  const timeoutMs = 12 * 60 * 1000;

  while (Date.now() - startedAt < timeoutMs) {
    if (!fs.existsSync(statusFile)) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    const status = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
    const phase = status.phase;
    if (['completed', 'error'].includes(phase)) {
      console.log(JSON.stringify({ phase, status }, null, 2));
      process.exit(phase === 'completed' ? 0 : 1);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Timed out waiting for run to finish. statusFile=${statusFile}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
