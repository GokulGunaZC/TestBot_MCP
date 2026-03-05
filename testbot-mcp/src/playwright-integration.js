/**
 * Playwright Integration
 * Handles test generation and execution using Playwright
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execSync } = require('child_process');
const Logger = require('./logger');

class PlaywrightIntegration {
  constructor(config = {}) {
    this.config = {
      projectPath: config.projectPath || process.cwd(),
      baseURL: config.baseURL || 'http://localhost:8000',
      port: config.port || 8000,
      startCommand: config.startCommand,
      serverStartTimeoutMs: Number.isFinite(Number(config.serverStartTimeoutMs))
        ? Number(config.serverStartTimeoutMs)
        : Number(process.env.TESTBOT_SERVER_START_TIMEOUT_MS || 90000),
      serverHealthCheckIntervalMs: Number.isFinite(Number(config.serverHealthCheckIntervalMs))
        ? Number(config.serverHealthCheckIntervalMs)
        : Number(process.env.TESTBOT_SERVER_HEALTHCHECK_INTERVAL_MS || 1000),
      testType: config.testType || 'both',
      timeout: config.timeout || 300000,
      browserMode: config.browserMode || 'chromium',
      artifactMode: config.artifactMode || 'hybrid',
      phaseMode: config.phaseMode || 'two-phase',
      allowPhase2OnGateFailure: config.allowPhase2OnGateFailure === true,
      ...config,
    };

    this.serverProcess = null;
  }

  getServerProbeUrls() {
    const candidates = [];
    const add = (value) => {
      if (!value) return;
      try {
        const parsed = new URL(String(value));
        candidates.push(parsed.toString());
      } catch {
        // ignore invalid URL candidate
      }
    };

    add(this.config.baseURL);
    try {
      const base = new URL(this.config.baseURL);
      add(`${base.protocol}//${base.host}/`);
      const fallbackPort = String(this.config.port || base.port || '');
      if (fallbackPort) {
        add(`${base.protocol}//localhost:${fallbackPort}/`);
        add(`${base.protocol}//127.0.0.1:${fallbackPort}/`);
      }
    } catch {
      const fallbackPort = String(this.config.port || '');
      if (fallbackPort) {
        add(`http://localhost:${fallbackPort}/`);
        add(`http://127.0.0.1:${fallbackPort}/`);
      }
    }

    return [...new Set(candidates)];
  }

  probeTcpPort(hostname, port, timeoutMs = 1200) {
    return new Promise((resolve) => {
      if (!hostname || !port) {
        resolve(false);
        return;
      }

      const socket = net.createConnection({ host: hostname, port });
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
  }

  stripAnsi(text) {
    if (typeof text !== 'string') {
      return '';
    }
    return text
      .replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  }

  resolvePlaywrightConfig() {
    const candidates = [
      'playwright.config.ts',
      'playwright.config.js',
      'playwright.config.mjs',
      'playwright.config.cjs',
    ];

    for (const name of candidates) {
      const candidate = path.join(this.config.projectPath, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  ensurePlaywrightInstalled() {
    const projectPath = this.config.projectPath;
    const playwrightPath = path.join(projectPath, 'node_modules', '@playwright', 'test');
    if (fs.existsSync(playwrightPath)) {
      return;
    }

    const bridge = this.ensureProjectPlaywrightBridge();
    if (bridge.ok) {
      if (bridge.bridged) {
        Logger.info('PlaywrightIntegration', 'Linked bundled @playwright/test into target project', {
          target: playwrightPath,
        });
      }
      return;
    }

    const packageJsonPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      Logger.warn('PlaywrightIntegration', 'Skipping npm install for @playwright/test because package.json is missing', {
        projectPath,
      });
      return;
    }

    Logger.info('PlaywrightIntegration', 'Installing Playwright...');
    try {
      execSync('npm install -D @playwright/test', { cwd: projectPath, stdio: 'pipe' });
    } catch (error) {
      Logger.error('PlaywrightIntegration', 'Failed to install Playwright', error);
      throw error;
    }
  }

  getBundledPlaywrightPackageDir() {
    try {
      return path.dirname(require.resolve('@playwright/test/package.json'));
    } catch {
      return null;
    }
  }

  ensureProjectPlaywrightBridge() {
    const projectPath = this.config.projectPath;
    const localPackageDir = path.join(projectPath, 'node_modules', '@playwright', 'test');

    if (fs.existsSync(localPackageDir)) {
      return { ok: true, bridged: false, packageDir: localPackageDir };
    }

    const bundledPackageDir = this.getBundledPlaywrightPackageDir();
    if (!bundledPackageDir) {
      return { ok: false, bridged: false, reason: 'bundled_playwright_missing' };
    }

    try {
      fs.mkdirSync(path.dirname(localPackageDir), { recursive: true });
      fs.symlinkSync(bundledPackageDir, localPackageDir, 'dir');
      return { ok: true, bridged: true, packageDir: localPackageDir };
    } catch (error) {
      if (fs.existsSync(localPackageDir)) {
        return { ok: true, bridged: false, packageDir: localPackageDir };
      }
      return {
        ok: false,
        bridged: false,
        reason: 'bridge_symlink_failed',
        error: error.message,
      };
    }
  }

  resolvePlaywrightCliPath() {
    try {
      return require.resolve('@playwright/test/cli', { paths: [this.config.projectPath] });
    } catch {
      // ignore and try package fallback
    }

    try {
      const packagePath = require.resolve('@playwright/test/package.json', { paths: [this.config.projectPath] });
      const cliPath = path.join(path.dirname(packagePath), 'cli.js');
      if (fs.existsSync(cliPath)) {
        return cliPath;
      }
    } catch {
      // ignore and try bridge/fallback
    }

    this.ensureProjectPlaywrightBridge();

    try {
      return require.resolve('@playwright/test/cli', { paths: [this.config.projectPath] });
    } catch {
      // ignore and fallback
    }

    try {
      const packagePath = require.resolve('@playwright/test/package.json', { paths: [this.config.projectPath] });
      const cliPath = path.join(path.dirname(packagePath), 'cli.js');
      if (fs.existsSync(cliPath)) {
        return cliPath;
      }
    } catch {
      // ignore and fallback
    }

    try {
      return require.resolve('@playwright/test/cli');
    } catch {
      // ignore and fallback
    }

    try {
      const packagePath = require.resolve('@playwright/test/package.json');
      const cliPath = path.join(path.dirname(packagePath), 'cli.js');
      if (fs.existsSync(cliPath)) {
        return cliPath;
      }
    } catch {
      // ignore and fallback
    }

    const bundledBin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'playwright');
    if (fs.existsSync(bundledBin)) {
      return bundledBin;
    }

    const projectBin = path.join(this.config.projectPath, 'node_modules', '.bin', 'playwright');
    if (fs.existsSync(projectBin)) {
      return projectBin;
    }

    return null;
  }

  buildRunnerInvocation(args) {
    const normalizedArgs = Array.isArray(args) && args[0] === 'playwright'
      ? args.slice(1)
      : [...(args || [])];
    const cliPath = this.resolvePlaywrightCliPath();
    const isJsCli = cliPath ? cliPath.endsWith('.js') : false;

    if (cliPath) {
      return {
        command: isJsCli ? process.execPath : cliPath,
        args: isJsCli ? [cliPath, ...normalizedArgs] : normalizedArgs,
        cliPath,
        label: isJsCli
          ? `${process.execPath} ${cliPath} ${normalizedArgs.join(' ')}`.trim()
          : `${cliPath} ${normalizedArgs.join(' ')}`.trim(),
      };
    }

    return {
      command: 'npx',
      args: ['--yes', '@playwright/test', ...normalizedArgs],
      cliPath: null,
      label: `npx --yes @playwright/test ${normalizedArgs.join(' ')}`.trim(),
    };
  }

  buildRunnerEnv(cliPath) {
    const currentNodePath = String(process.env.NODE_PATH || '')
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);

    const extraNodePaths = [path.join(this.config.projectPath, 'node_modules')];
    if (cliPath && cliPath.endsWith('.js')) {
      const cliNodeModules = path.resolve(path.dirname(cliPath), '..', '..');
      extraNodePaths.push(cliNodeModules);
    }

    return {
      ...process.env,
      BASE_URL: this.config.baseURL,
      NODE_PATH: [...new Set([...extraNodePaths, ...currentNodePath])].join(path.delimiter),
    };
  }

  extractJsonReporterOutputFiles(configPath) {
    if (!configPath || !fs.existsSync(configPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const matches = [...content.matchAll(/outputFile\s*:\s*['"`]([^'"`]+)['"`]/g)];
      return [...new Set(matches.map((match) => match[1]).filter(Boolean))];
    } catch (error) {
      Logger.warn('PlaywrightIntegration', 'Could not inspect playwright config for reporter paths', { reason: error.message });
      return [];
    }
  }

  resolveResultFileCandidates(configPath) {
    const projectPath = this.config.projectPath;
    const configuredJsonFiles = this.extractJsonReporterOutputFiles(configPath)
      .map((relativePath) => path.resolve(projectPath, relativePath));

    const defaults = [
      path.join(projectPath, 'test-results', 'results.json'),
      path.join(projectPath, 'test-results.json'),
    ];

    return [...new Set([...configuredJsonFiles, ...defaults])];
  }

  getArtifactPolicy() {
    if (this.config.artifactMode === 'full') {
      return {
        screenshot: 'on',
        video: 'on',
        trace: 'on',
      };
    }

    return {
      screenshot: 'on',
      video: 'retain-on-failure',
      trace: 'retain-on-failure',
    };
  }

  buildPlaywrightArgs({ configPath, project, lastFailed = false, forceJsonReporter = false, grep, grepInvert } = {}) {
    const args = ['playwright', 'test'];

    if (configPath) {
      args.push('--config', configPath);
    }

    const artifacts = this.getArtifactPolicy();

    // Playwright CLI supports --trace, but not --screenshot/--video flags.
    // Screenshot/video policy should come from playwright config defaults.
    if (artifacts.trace) {
      args.push('--trace', artifacts.trace);
    }

    if (project) {
      args.push('--project', project);
    }

    if (lastFailed) {
      args.push('--last-failed');
    }

    if (grep) {
      args.push('--grep', grep);
    }

    if (grepInvert) {
      args.push('--grep-invert', grepInvert);
    }

    if (forceJsonReporter || !configPath) {
      args.push('--reporter', 'json');
    }

    return args;
  }

  runPlaywrightCommand(args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const invocation = this.buildRunnerInvocation(args);
      Logger.info('PlaywrightIntegration', `Running: ${invocation.label}`);

      const proc = spawn(invocation.command, invocation.args, {
        cwd: this.config.projectPath,
        env: this.buildRunnerEnv(invocation.cliPath),
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`Playwright execution timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          code,
          stdout,
          stderr,
          commandLabel: invocation.label,
        });
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Playwright execution failed: ${error.message}`));
      });
    });
  }

  async executePlaywright({ project, lastFailed = false, grep, grepInvert } = {}) {
    this.ensurePlaywrightInstalled();

    const configPath = this.resolvePlaywrightConfig();
    const timeoutMs = Math.max(1000, this.config.timeout || 300000);
    const forceJsonReporter = !configPath;
    const args = this.buildPlaywrightArgs({
      configPath,
      project,
      lastFailed,
      forceJsonReporter,
      grep,
      grepInvert,
    });

    const commandStartedAt = Date.now();
    const commandResult = await this.runPlaywrightCommand(args, timeoutMs);
    const testResults = this.parseTestResults({
      stdout: commandResult.stdout,
      stderr: commandResult.stderr,
      configPath,
      commandStartedAt,
    });

    if (commandResult.code !== 0 && testResults.total === 0) {
      const stderrPreview = this.stripAnsi(commandResult.stderr || commandResult.stdout || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
      const errorSuffix = stderrPreview ? `: ${stderrPreview}` : '';
      throw new Error(`Playwright execution failed with exit code ${commandResult.code}${errorSuffix}`);
    }

    return {
      ...testResults,
      runner: {
        exitCode: commandResult.code,
        project: project || 'default',
        command: commandResult.commandLabel || `npx ${args.join(' ')}`,
      },
    };
  }

  async runSecondaryBrowserReruns(primaryResult) {
    const mode = String(this.config.browserMode || 'chromium').toLowerCase();
    if (!['smoke-matrix', 'full-matrix'].includes(mode)) {
      return [];
    }

    if (!primaryResult || primaryResult.failed <= 0) {
      return [];
    }

    const secondaryProjects = mode === 'full-matrix'
      ? ['firefox', 'webkit']
      : ['firefox'];

    const reruns = [];
    const rerunTimeoutMs = Math.max(30000, Math.floor(this.config.timeout * 0.5));

    for (const project of secondaryProjects) {
      try {
        const rerunStartedAt = Date.now();
        const args = this.buildPlaywrightArgs({
          configPath: this.resolvePlaywrightConfig(),
          project,
          lastFailed: true,
          forceJsonReporter: true,
        });

        const commandResult = await this.runPlaywrightCommand(args, rerunTimeoutMs);
        const parsed = this.parseTestResults({
          stdout: commandResult.stdout,
          stderr: commandResult.stderr,
          configPath: this.resolvePlaywrightConfig(),
          commandStartedAt: rerunStartedAt,
        });

        reruns.push({
          project,
          ...parsed,
          exitCode: commandResult.code,
        });
      } catch (error) {
        reruns.push({
          project,
          error: error.message,
          total: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          duration: 0,
          tests: [],
          failures: [],
        });
      }
    }

    return reruns;
  }

  hasPhaseTwoTaggedTests() {
    try {
      const generatedDir = path.join(this.config.projectPath, 'tests', 'generated');
      if (!fs.existsSync(generatedDir)) {
        return false;
      }

      const files = fs.readdirSync(generatedDir).filter((name) => /\.spec\.(ts|js)$/i.test(name));
      const phaseTwoTagPattern = /@phase2|@deep|@stress|@matrix|@load|@api-stress|@api-negative|@api-auth|@api-contract/i;

      for (const file of files) {
        const fullPath = path.join(generatedDir, file);
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (phaseTwoTagPattern.test(content)) {
          return true;
        }
      }
    } catch (error) {
      Logger.warn('PlaywrightIntegration', 'Failed to inspect phase-two tags', { reason: error.message });
    }

    return false;
  }

  combinePhaseResults(phaseOne, phaseTwo) {
    const combined = {
      total: Number(phaseOne.total || 0) + Number(phaseTwo.total || 0),
      passed: Number(phaseOne.passed || 0) + Number(phaseTwo.passed || 0),
      failed: Number(phaseOne.failed || 0) + Number(phaseTwo.failed || 0),
      skipped: Number(phaseOne.skipped || 0) + Number(phaseTwo.skipped || 0),
      duration: Number(phaseOne.duration || 0) + Number(phaseTwo.duration || 0),
      tests: [...(phaseOne.tests || []), ...(phaseTwo.tests || [])],
      failures: [...(phaseOne.failures || []), ...(phaseTwo.failures || [])],
      phaseResults: {
        phase1: {
          status: phaseOne.failed > 0 ? 'failed' : 'passed',
          total: Number(phaseOne.total || 0),
          passed: Number(phaseOne.passed || 0),
          failed: Number(phaseOne.failed || 0),
          skipped: Number(phaseOne.skipped || 0),
          duration: Number(phaseOne.duration || 0),
        },
        phase2: {
          status: phaseTwo.failed > 0 ? 'failed' : 'passed',
          total: Number(phaseTwo.total || 0),
          passed: Number(phaseTwo.passed || 0),
          failed: Number(phaseTwo.failed || 0),
          skipped: Number(phaseTwo.skipped || 0),
          duration: Number(phaseTwo.duration || 0),
        },
      },
    };

    return combined;
  }

  async runTwoPhaseExecution() {
    const gatePattern = '@phase2|@deep|@stress|@matrix|@load|@api-stress|@api-negative|@api-auth|@api-contract';
    const phaseOne = await this.executePlaywright({ grepInvert: gatePattern });
    const allowPhaseTwoOnGateFailure = this.config.allowPhase2OnGateFailure === true;

    if (phaseOne.failed > 0 && !allowPhaseTwoOnGateFailure) {
      return {
        ...phaseOne,
        phaseResults: {
          phase1: {
            status: 'failed',
            total: Number(phaseOne.total || 0),
            passed: Number(phaseOne.passed || 0),
            failed: Number(phaseOne.failed || 0),
            skipped: Number(phaseOne.skipped || 0),
            duration: Number(phaseOne.duration || 0),
          },
          phase2: {
            status: 'skipped',
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            duration: 0,
            reason: 'phase1_failed',
          },
        },
      };
    }

    if (!this.hasPhaseTwoTaggedTests()) {
      return {
        ...phaseOne,
        phaseResults: {
          phase1: {
            status: phaseOne.failed > 0 ? 'failed' : 'passed',
            total: Number(phaseOne.total || 0),
            passed: Number(phaseOne.passed || 0),
            failed: Number(phaseOne.failed || 0),
            skipped: Number(phaseOne.skipped || 0),
            duration: Number(phaseOne.duration || 0),
          },
          phase2: {
            status: 'skipped',
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            duration: 0,
            reason: 'no_phase2_tagged_tests',
          },
        },
      };
    }

    const phaseTwo = await this.executePlaywright({ grep: gatePattern });
    return this.combinePhaseResults(phaseOne, phaseTwo);
  }

  /**
   * Generate tests from PRD or Jira stories
   */
  async generateTests({ prdFile, jiraStories }) {
    const testsDir = path.join(this.config.projectPath, 'tests', 'generated');
    if (!fs.existsSync(testsDir)) {
      fs.mkdirSync(testsDir, { recursive: true });
    }

    const generatedTests = [];

    if (jiraStories && jiraStories.length > 0) {
      for (const story of jiraStories) {
        const testCode = this.generateTestFromStory(story);
        const filename = `${story.key.toLowerCase().replace(/-/g, '_')}.spec.js`;
        const filepath = path.join(testsDir, filename);

        fs.writeFileSync(filepath, testCode, 'utf-8');
        generatedTests.push(filepath);
      }
    }

    if (prdFile && fs.existsSync(prdFile)) {
      const prdContent = fs.readFileSync(prdFile, 'utf-8');
      const scenarios = this.parsePRDScenarios(prdContent);

      for (const scenario of scenarios) {
        const testCode = this.generateTestFromScenario(scenario);
        const filename = `prd_${scenario.name.toLowerCase().replace(/\s+/g, '_')}.spec.js`;
        const filepath = path.join(testsDir, filename);

        fs.writeFileSync(filepath, testCode, 'utf-8');
        generatedTests.push(filepath);
      }
    }

    return {
      generated: generatedTests.length,
      files: generatedTests,
    };
  }

  generateTestFromStory(story) {
    const summary = this.sanitizeString(story.summary || 'Story test');
    const criteria = story.acceptanceCriteria || [];

    let testCases = '';
    if (criteria.length === 0) {
      testCases = `
  test('renders home page', async ({ page }) => {
    const response = await page.goto('/');
    expect(response).not.toBeNull();
    expect((response?.status() || 0)).toBeLessThan(500);
    await expect(page.locator('body')).toBeVisible();
  });
`;
    } else {
      criteria.forEach((criterion) => {
        testCases += `
  test('${this.sanitizeString(criterion)}', async ({ page }) => {
    const response = await page.goto('/');
    expect(response).not.toBeNull();
    expect((response?.status() || 0)).toBeLessThan(500);
    await expect(page.locator('body')).toBeVisible();
  });
`;
      });
    }

    return `// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('${story.key}: ${summary}', () => {
${testCases}
});
`;
  }

  generateTestFromScenario(scenario) {
    return `// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('${this.sanitizeString(scenario.name)}', () => {
  test('${this.sanitizeString(scenario.name)}', async ({ page }) => {
    const response = await page.goto('/');
    expect(response).not.toBeNull();
    expect((response?.status() || 0)).toBeLessThan(500);
    await expect(page.locator('body')).toBeVisible();
  });
});
`;
  }

  parsePRDScenarios(prdContent) {
    const scenarios = [];
    const lines = prdContent.split('\n');

    let currentScenario = null;
    let inScenario = false;

    for (const line of lines) {
      const trimmedLine = line.trim();

      if (trimmedLine.match(/^#+\s*(scenario|test|feature|user story)/i)) {
        if (currentScenario) {
          scenarios.push(currentScenario);
        }
        currentScenario = {
          name: trimmedLine.replace(/^#+\s*/, ''),
          description: '',
          steps: [],
        };
        inScenario = true;
      } else if (inScenario && currentScenario) {
        const stepMatch = trimmedLine.match(/^[-*]\s*(Given|When|Then|And)\s+(.+)/i);
        if (stepMatch) {
          currentScenario.steps.push(`${stepMatch[1]} ${stepMatch[2]}`);
        } else if (trimmedLine && !trimmedLine.startsWith('#')) {
          currentScenario.description += `${trimmedLine} `;
        }
      }
    }

    if (currentScenario) {
      scenarios.push(currentScenario);
    }

    return scenarios;
  }

  /**
   * Run Playwright tests
   */
  async runTests() {
    if (this.config.startCommand) {
      await this.startServer();
    }

    try {
      const phaseMode = String(this.config.phaseMode || 'two-phase').toLowerCase();
      const primary = phaseMode === 'two-phase'
        ? await this.runTwoPhaseExecution()
        : await this.executePlaywright();
      const secondary = await this.runSecondaryBrowserReruns(primary);

      if (secondary.length > 0) {
        primary.browserReruns = secondary;
      }

      if (!primary.phaseResults) {
        primary.phaseResults = {
          phase1: {
            status: primary.failed > 0 ? 'failed' : 'passed',
            total: Number(primary.total || 0),
            passed: Number(primary.passed || 0),
            failed: Number(primary.failed || 0),
            skipped: Number(primary.skipped || 0),
            duration: Number(primary.duration || 0),
          },
          phase2: {
            status: 'skipped',
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            duration: 0,
            reason: 'single_phase_mode',
          },
        };
      }

      return primary;
    } finally {
      if (this.serverProcess) {
        this.stopServer();
      }
    }
  }

  parseTestResults({ stdout, stderr, configPath, commandStartedAt }) {
    let results = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      tests: [],
      failures: [],
    };

    const cleanStdout = this.stripAnsi(stdout || '');
    const cleanStderr = this.stripAnsi(stderr || '');

    const candidates = this.resolveResultFileCandidates(configPath);
    for (const candidatePath of candidates) {
      if (!fs.existsSync(candidatePath)) {
        continue;
      }

      if (Number.isFinite(commandStartedAt)) {
        try {
          const stat = fs.statSync(candidatePath);
          if (stat.mtimeMs + 25 < commandStartedAt) {
            continue;
          }
        } catch {
          continue;
        }
      }

      try {
        const data = JSON.parse(fs.readFileSync(candidatePath, 'utf-8'));
        results = this.extractResultsFromJson(data);
        if (results.total > 0) {
          return results;
        }
      } catch (error) {
        Logger.warn('PlaywrightIntegration', 'Failed to parse JSON result file', {
          path: candidatePath,
          reason: error.message,
        });
      }
    }

    try {
      const parsedStdout = JSON.parse(cleanStdout);
      results = this.extractResultsFromJson(parsedStdout);
      if (results.total > 0) {
        return results;
      }
    } catch {
      // ignore and continue to fallback text parsing
    }

    const combinedOutput = `${cleanStdout}\n${cleanStderr}`;
    const passedMatch = combinedOutput.match(/(\d+)\s+passed/i);
    const failedMatch = combinedOutput.match(/(\d+)\s+failed/i);
    const skippedMatch = combinedOutput.match(/(\d+)\s+skipped/i);

    results.passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
    results.failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
    results.skipped = skippedMatch ? parseInt(skippedMatch[1], 10) : 0;
    results.total = results.passed + results.failed + results.skipped;

    return results;
  }

  extractResultsFromJson(data) {
    const results = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      tests: [],
      failures: [],
    };

    if (!data || !Array.isArray(data.suites)) {
      return results;
    }

    const normalizeError = (error) => {
      if (!error) return null;
      if (typeof error === 'string') {
        const cleaned = this.stripAnsi(error);
        return cleaned ? { message: cleaned } : null;
      }
      if (typeof error === 'object') {
        const callLog = Array.isArray(error.callLog)
          ? error.callLog
            .map((entry) => this.stripAnsi(String(entry || '')))
            .filter(Boolean)
            .slice(0, 30)
          : null;

        const location = error.location && typeof error.location === 'object'
          ? {
            file: this.stripAnsi(String(error.location.file || '')),
            line: Number.isFinite(error.location.line) ? error.location.line : null,
            column: Number.isFinite(error.location.column) ? error.location.column : null,
          }
          : null;

        const message = this.stripAnsi(String(error.message || error.value || ''));
        const stack = this.stripAnsi(String(error.stack || ''));
        const snippet = this.stripAnsi(String(error.snippet || error.codeFrame || ''));
        const value = this.stripAnsi(String(error.value || ''));

        return {
          message: message || stack || value || 'Unknown Playwright failure',
          stack: stack || null,
          value: value || null,
          snippet: snippet || null,
          location,
          callLog,
        };
      }
      return { message: this.stripAnsi(String(error)) };
    };

    const processSpec = (spec, suiteName) => {
      if (!Array.isArray(spec.tests)) {
        return;
      }

      for (const test of spec.tests) {
        const lastResult = test.results?.[test.results.length - 1] || null;
        const status = lastResult?.status || test.status || 'unknown';
        const normalizedStatus = this.normalizeStatus(status);
        const artifacts = this.extractArtifacts(lastResult?.attachments || []);
        const normalizedError = normalizeError(
          lastResult?.error
          || (Array.isArray(lastResult?.errors) ? lastResult.errors.find(Boolean) : null)
          || (Array.isArray(test.errors) ? test.errors.find(Boolean) : null)
          || null
        );

        const testObj = {
          id: `${suiteName}-${spec.title}-${test.projectName || 'default'}`.replace(/\s+/g, '-'),
          title: this.stripAnsi(String(spec.title || test.title || 'Unnamed test')),
          suite: this.stripAnsi(String(suiteName || '')),
          file: this.stripAnsi(String(spec.file || '')),
          status: normalizedStatus,
          duration: lastResult?.duration || 0,
          retries: Math.max(0, (test.results?.length || 1) - 1),
          projectName: test.projectName || null,
          error: normalizedError,
          artifacts,
        };

        results.tests.push(testObj);
        results.total += 1;
        results.duration += testObj.duration;

        if (normalizedStatus === 'passed') {
          results.passed += 1;
        } else if (normalizedStatus === 'failed') {
          results.failed += 1;
          results.failures.push({
            testName: testObj.title,
            file: testObj.file,
            error: normalizedError,
            status: normalizedStatus,
            duration: testObj.duration,
            artifacts,
            projectName: testObj.projectName,
          });
        } else if (normalizedStatus === 'skipped') {
          results.skipped += 1;
        }
      }
    };

    const processSuite = (suite, parentName = '') => {
      const suiteName = parentName
        ? `${parentName} > ${suite.title || 'suite'}`
        : (suite.title || 'suite');

      for (const spec of suite.specs || []) {
        processSpec(spec, suiteName);
      }

      for (const childSuite of suite.suites || []) {
        processSuite(childSuite, suiteName);
      }
    };

    for (const suite of data.suites) {
      processSuite(suite);
    }

    return results;
  }

  extractArtifacts(attachments) {
    const artifacts = {
      screenshots: [],
      videos: [],
      traces: [],
      other: [],
    };

    for (const attachment of attachments || []) {
      const contentType = String(attachment.contentType || '');
      const artifact = {
        name: this.stripAnsi(String(attachment.name || 'artifact')),
        path: attachment.path,
        contentType,
      };

      if (contentType.includes('image')) {
        artifacts.screenshots.push(artifact);
      } else if (contentType.includes('video')) {
        artifacts.videos.push(artifact);
      } else if (artifact.name.toLowerCase().includes('trace') || contentType.includes('zip')) {
        artifacts.traces.push(artifact);
      } else {
        artifacts.other.push(artifact);
      }
    }

    return artifacts;
  }

  async loadTestResults(testResultsPath) {
    if (!fs.existsSync(testResultsPath)) {
      throw new Error(`Test results not found: ${testResultsPath}`);
    }

    const data = JSON.parse(fs.readFileSync(testResultsPath, 'utf-8'));
    return this.extractResultsFromJson(data);
  }

  async startServer() {
    if (!this.config.startCommand) return;

    return new Promise((resolve, reject) => {
      Logger.info('PlaywrightIntegration', `Starting server: ${this.config.startCommand}`);
      const detached = process.platform !== 'win32';
      const startupTimeoutMs = Math.max(10000, Number(this.config.serverStartTimeoutMs || 90000));
      const healthCheckIntervalMs = Math.max(250, Number(this.config.serverHealthCheckIntervalMs || 1000));
      let settled = false;
      let serverExited = false;
      let recentServerLogs = [];
      let sawReadinessLogHint = false;
      const readinessLogPattern = /(listening on|running on|application startup complete|started server|ready in|serving on|development server at|uvicorn running|werkzeug)/i;

      this.serverProcess = spawn(this.config.startCommand, {
        cwd: this.config.projectPath,
        shell: true,
        detached,
        env: {
          ...process.env,
          BASE_URL: this.config.baseURL,
          PORT: String(this.config.port || ''),
        },
      });

      const rememberLog = (chunk) => {
        const text = this.stripAnsi(String(chunk || '')).trim();
        if (!text) return;
        const compact = text.length > 280 ? `${text.slice(0, 280)}...` : text;
        recentServerLogs.push(compact);
        if (recentServerLogs.length > 24) {
          recentServerLogs = recentServerLogs.slice(-24);
        }
        if (readinessLogPattern.test(text)) {
          sawReadinessLogHint = true;
        }
      };

      this.serverProcess.stdout.on('data', (data) => {
        rememberLog(data.toString());
        Logger.debug('PlaywrightIntegration', `[Server] ${data.toString()}`);
      });

      this.serverProcess.stderr.on('data', (data) => {
        rememberLog(data.toString());
        Logger.debug('PlaywrightIntegration', `[Server] ${data.toString()}`);
      });

      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      this.serverProcess.on('error', (error) => {
        finish(new Error(`Server process failed to start: ${error.message}`));
      });

      this.serverProcess.on('exit', (code, signal) => {
        serverExited = true;
        if (!settled) {
          const logTail = recentServerLogs.length > 0
            ? ` Last server logs: ${recentServerLogs.slice(-6).join(' | ')}`
            : '';
          finish(new Error(`Server process exited before becoming ready (code=${code}, signal=${signal || 'none'}).${logTail}`));
        }
      });

      const fetchFn = global.fetch || ((url) => import('node-fetch').then((module) => module.default(url)));
      const probeUrls = this.getServerProbeUrls();
      const startedAt = Date.now();

      const checkServer = async () => {
        while (Date.now() - startedAt < startupTimeoutMs) {
          if (serverExited) {
            return;
          }

          for (const probeUrl of probeUrls) {
            try {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 1800);
              const response = await fetchFn(probeUrl, {
                signal: controller.signal,
              });
              clearTimeout(timer);
              if (response.ok || response.status < 500) {
                Logger.info('PlaywrightIntegration', 'Server is ready', { probeUrl });
                finish();
                return;
              }
            } catch {
              // keep probing
            }
          }

          // Fallback: if logs indicate readiness and TCP port is open, treat server as ready.
          if (sawReadinessLogHint) {
            try {
              const parsed = new URL(this.config.baseURL);
              const tcpPort = Number(this.config.port || parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
              const tcpReady = await this.probeTcpPort(parsed.hostname || 'localhost', tcpPort);
              if (tcpReady) {
                Logger.info('PlaywrightIntegration', 'Server is ready (TCP readiness fallback)');
                finish();
                return;
              }
            } catch {
              // ignore malformed URL
            }
          }

          await new Promise((done) => setTimeout(done, healthCheckIntervalMs));
        }

        const logTail = recentServerLogs.length > 0
          ? ` Last server logs: ${recentServerLogs.slice(-8).join(' | ')}`
          : '';
        finish(new Error(
          `Server failed to start within ${startupTimeoutMs}ms. Probed URLs: ${probeUrls.join(', ')}.${logTail}`
        ));
      };

      checkServer();
    });
  }

  stopServer() {
    if (!this.serverProcess) {
      return;
    }

    Logger.info('PlaywrightIntegration', 'Stopping server');
    try {
      process.kill(-this.serverProcess.pid);
    } catch {
      this.serverProcess.kill();
    }

    this.serverProcess = null;
  }

  sanitizeString(str) {
    if (!str) return '';
    return String(str)
      .replace(/['"]/g, '')
      .replace(/[<>]/g, '')
      .replace(/\n/g, ' ')
      .trim()
      .substring(0, 100);
  }

  normalizeStatus(status) {
    if (!status) return 'unknown';
    const normalized = String(status).toLowerCase();
    if (normalized === 'expected') return 'passed';
    if (normalized === 'unexpected' || normalized === 'timedout') return 'failed';
    if (normalized === 'pending') return 'skipped';
    return normalized;
  }
}

module.exports = PlaywrightIntegration;
