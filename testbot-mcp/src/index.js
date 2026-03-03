/**
 * Testbot MCP Server
 * One-command testing with AI-powered analysis for any project
 *
 * Usage: User says "test my app using testbot mcp" in Cursor/Windsurf
 */

// Load environment variables - try multiple paths since CWD varies when launched from IDE
const path = require('path');
const dotenvPaths = [
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', '..', '.env'),
  path.join(process.cwd(), '.env'),
];
for (const envPath of dotenvPaths) {
  const { error } = require('dotenv').config({ path: envPath });
  if (!error) { break; } // stop at first working .env
}

const { fork } = require('child_process');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const AutoDetector = require('./auto-detector');
const PlaywrightIntegration = require('./playwright-integration');
const AIAnalyzer = require('./ai-providers/index');
const ReportGenerator = require('./report-generator');
const DashboardLauncher = require('./dashboard-launcher');

class TestbotMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'testbot-mcp',
        version: '1.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  /**
   * Fork a background worker to run the full test pipeline.
   * Returns immediately so the MCP request handler can respond fast.
   */
  runPipelineInBackground(config, runId) {
    const workerPath = path.join(__dirname, 'pipeline-worker.js');

    const child = fork(workerPath, [], {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env },
    });

    // Pipe worker stderr to our stderr for debugging
    if (child.stderr) {
      child.stderr.on('data', (data) => {
        process.stderr.write(data);
      });
    }

    // Send config to worker via IPC
    child.send({ config, runId });

    // Disconnect IPC and unref so MCP server is not blocked
    child.on('message', () => {}); // drain any messages
    setTimeout(() => {
      try { child.disconnect(); } catch (e) { /* already disconnected */ }
    }, 1000);
    child.unref();

    console.error(`[Testbot] Pipeline worker forked (PID: ${child.pid}, runId: ${runId})`);
  }

  setupToolHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'testbot_configure',
          description: 'Analyze a project and return configuration options before testing. Use this first to understand the project structure, then use the returned configuration with testbot_test_my_app. Returns detected settings and questions for the user to answer.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the project to analyze (defaults to current workspace)',
              },
            },
          },
        },
        {
          name: 'testbot_test_my_app',
          description: 'Test your application end-to-end with AI-powered analysis. Generates tests, runs them, analyzes failures with AI, and opens a beautiful dashboard with results. Returns immediately with a run ID — the pipeline runs in the background and posts results to the dashboard when complete. For best results, run testbot_configure first to get recommended settings.',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the project to test (defaults to current workspace)',
              },
              testType: {
                type: 'string',
                enum: ['frontend', 'backend', 'both'],
                description: 'Type of tests to run',
              },
              generateTests: {
                type: 'boolean',
                description: 'Whether to generate new tests (true) or use existing tests (false)',
              },
              prdFile: {
                type: 'string',
                description: 'Path to PRD/requirements document for test generation (optional)',
              },
              codebaseContext: {
                type: 'object',
                description: 'Structured codebase context from AI agent analysis (pages, apiEndpoints, workflows)',
                properties: {
                  pages: {
                    type: 'array',
                    description: 'Frontend pages/routes with their components and interactions',
                    items: { type: 'object' }
                  },
                  apiEndpoints: {
                    type: 'array',
                    description: 'Backend API endpoints with methods and schemas',
                    items: { type: 'object' }
                  },
                  workflows: {
                    type: 'array',
                    description: 'Main user workflows to test',
                    items: { type: 'string' }
                  },
                },
              },
              baseURL: {
                type: 'string',
                description: 'Base URL for the application under test',
              },
              port: {
                type: 'number',
                description: 'Port number the app runs on',
              },
              startCommand: {
                type: 'string',
                description: 'Command to start the app server (e.g., "npm start")',
              },
              jira: {
                type: 'object',
                description: 'Jira integration configuration',
                properties: {
                  enabled: { type: 'boolean' },
                  baseUrl: { type: 'string' },
                  email: { type: 'string' },
                  apiToken: { type: 'string' },
                  projectKey: { type: 'string' },
                },
              },
              openDashboard: {
                type: 'boolean',
                description: 'Whether to automatically open the dashboard after tests (default: true)',
              },
            },
          },
        },
        {
          name: 'testbot_analyze_failures',
          description: 'Analyze existing test failures with AI without running new tests',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the project',
              },
              testResultsPath: {
                type: 'string',
                description: 'Path to test-results.json file',
              },
              aiProvider: {
                type: 'string',
                enum: ['sarvam', 'cascade', 'windsurf'],
                description: 'AI provider for failure analysis',
              },
            },
            required: ['projectPath'],
          },
        },
        {
          name: 'testbot_generate_report',
          description: 'Generate a dashboard report from existing test results',
          inputSchema: {
            type: 'object',
            properties: {
              projectPath: {
                type: 'string',
                description: 'Path to the project',
              },
              testResultsPath: {
                type: 'string',
                description: 'Path to test-results.json file',
              },
              openDashboard: {
                type: 'boolean',
                description: 'Whether to automatically open the dashboard',
              },
            },
            required: ['projectPath'],
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'testbot_configure':
            return await this.handleConfigure(args);
          case 'testbot_test_my_app':
            return await this.handleTestMyApp(args);
          case 'testbot_analyze_failures':
            return await this.handleAnalyzeFailures(args);
          case 'testbot_generate_report':
            return await this.handleGenerateReport(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}\n${error.stack}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  setupErrorHandling() {
    this.server.onerror = (error) => {
      console.error('[Testbot MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  /**
   * Configure tool: Analyze project and return configuration options
   */
  async handleConfigure(params) {
    const log = (msg) => console.error(`[Testbot] ${msg}`);
    const fs = require('fs');
    const path = require('path');

    try {
      const projectPath = params.projectPath || process.cwd();

      log('Analyzing project for configuration...');

      // 1. Auto-detect project settings
      const detector = new AutoDetector();
      const context = await detector.detect(projectPath);

      log(`Detected project: ${context.projectName} (${context.language})`);
      log(`Framework detection: ${context.hasPlaywright ? 'Playwright found' : 'No Playwright config'}`);

      // 2. Scan for existing tests
      const existingTests = this.scanExistingTests(projectPath);
      log(`Found ${existingTests.count} existing test files`);

      // 3. Check for PRD/requirements files
      const prdFiles = this.findPRDFiles(projectPath);
      log(`Found ${prdFiles.length} potential PRD files`);

      // 4. Check for Jira configuration
      const hasJiraConfig = context.hasJira || !!(
        process.env.JIRA_BASE_URL &&
        process.env.JIRA_API_TOKEN &&
        process.env.JIRA_PROJECT_KEY
      );

      // 5. Build configuration response with questions
      const config = {
        projectInfo: {
          name: context.projectName,
          path: context.projectPath,
          language: context.language,
          ecosystem: context.ecosystem,
          framework: this.detectFramework(context),
          port: context.port,
          baseURL: context.baseURL,
          startCommand: context.startCommand,
          hasPlaywrightConfig: context.hasPlaywright,
          hasExistingTests: existingTests.count > 0,
          existingTestFiles: existingTests.files.slice(0, 10),
          totalTestFiles: existingTests.count,
          testDirectories: context.testDirs,
        },
        prdFiles: prdFiles,
        jiraAvailable: hasJiraConfig,
        aiProviderAvailable: !!(process.env.SARVAM_API_KEY || process.env.AI_API_KEY),

        // Questions for the user to answer
        questions: [
          {
            id: 'testScope',
            prompt: 'What would you like to test?',
            options: ['frontend', 'backend', 'both'],
            default: 'both',
            description: 'Choose frontend for UI tests, backend for API tests, or both for full coverage'
          },
          {
            id: 'generateTests',
            prompt: existingTests.count > 0
              ? `Found ${existingTests.count} existing tests. Generate new tests or use existing?`
              : 'No existing tests found. Should I generate tests?',
            options: existingTests.count > 0
              ? ['generate_new', 'use_existing', 'both']
              : ['generate_new', 'skip'],
            default: existingTests.count > 0 ? 'use_existing' : 'generate_new',
            description: 'generate_new creates tests from codebase analysis, use_existing runs your current tests'
          },
        ],

        // Context prompt for the AI agent to analyze codebase
        contextPrompt: this.buildContextPrompt(projectPath, context),

        // Recommended configuration based on detection
        recommendedConfig: {
          projectPath: context.projectPath,
          testType: 'both',
          baseURL: context.baseURL,
          port: context.port,
          startCommand: context.startCommand,
          generateTests: existingTests.count === 0,
          prdFile: prdFiles.length > 0 ? prdFiles[0] : null,
          aiProvider: process.env.AI_PROVIDER || 'sarvam',
          openDashboard: true,
        }
      };

      // Add PRD question if files found
      if (prdFiles.length > 0) {
        config.questions.push({
          id: 'usePRD',
          prompt: `Found potential PRD file(s): ${prdFiles.join(', ')}. Use for test generation?`,
          options: ['yes', 'no', 'specify_other'],
          default: 'yes',
          description: 'PRD files help generate more accurate tests based on requirements'
        });
      }

      // Add Jira question if available
      if (hasJiraConfig) {
        config.questions.push({
          id: 'useJira',
          prompt: 'Jira integration is configured. Fetch stories for test generation?',
          options: ['yes', 'no'],
          default: 'no',
          description: 'Fetch active Jira stories and generate tests from acceptance criteria'
        });
      }

      // Add AI analysis question
      if (config.aiProviderAvailable) {
        config.questions.push({
          id: 'enableAI',
          prompt: 'Enable AI-powered failure analysis?',
          options: ['yes', 'no'],
          default: 'yes',
          description: 'AI will analyze any test failures and suggest fixes'
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(config, null, 2),
          },
        ],
      };
    } catch (error) {
      log(`Configuration error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Scan for existing test files
   */
  scanExistingTests(projectPath) {
    const fs = require('fs');
    const path = require('path');
    const testDirs = ['tests', 'test', '__tests__', 'spec', 'specs', 'e2e', 'cypress', 'playwright'];
    const testPatterns = ['.spec.js', '.spec.ts', '.test.js', '.test.ts', '.e2e.js', '.e2e.ts'];
    const files = [];

    const scanDir = (dir) => {
      if (!fs.existsSync(dir)) return;

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory() && !entry.name.includes('node_modules')) {
            scanDir(fullPath);
          } else if (entry.isFile()) {
            if (testPatterns.some(pattern => entry.name.endsWith(pattern))) {
              files.push(path.relative(projectPath, fullPath));
            }
          }
        }
      } catch (error) {
        // Ignore permission errors
      }
    };

    // Scan test directories
    for (const testDir of testDirs) {
      scanDir(path.join(projectPath, testDir));
    }

    // Also check root for test files
    scanDir(projectPath);

    return {
      count: files.length,
      files: files
    };
  }

  /**
   * Find PRD/requirements files
   */
  findPRDFiles(projectPath) {
    const fs = require('fs');
    const path = require('path');
    const prdPatterns = [
      'prd.md', 'PRD.md', 'plan.md', 'Plan.md',
      'requirements.md', 'Requirements.md', 'REQUIREMENTS.md',
      'spec.md', 'specs.md', 'specification.md',
      'docs/prd.md', 'docs/requirements.md', 'docs/plan.md',
      'documentation/prd.md', 'documentation/requirements.md',
    ];

    const found = [];

    for (const pattern of prdPatterns) {
      const filePath = path.join(projectPath, pattern);
      if (fs.existsSync(filePath)) {
        found.push(pattern);
      }
    }

    // Also check for README if nothing else found
    if (found.length === 0) {
      const readmePath = path.join(projectPath, 'README.md');
      if (fs.existsSync(readmePath)) {
        try {
          const content = fs.readFileSync(readmePath, 'utf-8').toLowerCase();
          if (content.includes('requirements') || content.includes('features') || content.includes('user stories')) {
            found.push('README.md (contains requirements section)');
          }
        } catch (error) {
          // Ignore read errors
        }
      }
    }

    return found;
  }

  /**
   * Detect framework from context
   */
  detectFramework(context) {
    const packageJson = context.packageJson;
    if (!packageJson?.dependencies && !packageJson?.devDependencies) {
      // For non-Node.js projects, return language-based framework
      if (context.language && context.language !== 'javascript') {
        return context.language.charAt(0).toUpperCase() + context.language.slice(1);
      }
      return 'Unknown';
    }

    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    };

    if (allDeps.next) return 'Next.js';
    if (allDeps.nuxt) return 'Nuxt.js';
    if (allDeps['@angular/core']) return 'Angular';
    if (allDeps.vue) return 'Vue.js';
    if (allDeps.react) return 'React';
    if (allDeps.svelte) return 'Svelte';
    if (allDeps.express) return 'Express.js';
    if (allDeps.fastify) return 'Fastify';
    if (allDeps.koa) return 'Koa';
    if (allDeps.nest) return 'NestJS';

    return 'Node.js';
  }

  /**
   * Build context prompt for AI agent to analyze codebase
   */
  buildContextPrompt(projectPath, context) {
    return `
Please analyze the codebase at ${projectPath} and provide structured information for test generation.

**Project Info:**
- Name: ${context.projectName}
- Language: ${context.language || 'Unknown'}
- Framework: ${this.detectFramework(context)}
- Port: ${context.port}
- Base URL: ${context.baseURL}

**Please analyze and return JSON with this structure:**

\`\`\`json
{
  "pages": [
    {
      "path": "/login",
      "description": "User login page",
      "components": ["LoginForm", "ForgotPasswordLink"],
      "interactions": ["email input", "password input", "submit button", "forgot password link"]
    }
  ],
  "apiEndpoints": [
    {
      "method": "POST",
      "path": "/api/auth/login",
      "description": "User authentication",
      "requiresAuth": false,
      "requestBody": { "email": "string", "password": "string" },
      "responseSchema": { "token": "string", "user": "object" }
    }
  ],
  "workflows": [
    "User registration flow",
    "User login flow",
    "Main feature workflow"
  ],
  "testPriorities": [
    { "feature": "Authentication", "priority": "high", "reason": "Core functionality" },
    { "feature": "Main dashboard", "priority": "high", "reason": "Primary user interface" }
  ]
}
\`\`\`

Look for:
1. Route definitions (pages, API routes)
2. Component files
3. Form handlers
4. API endpoint definitions
5. Authentication logic
6. Main user workflows

Return the JSON structure above based on what you find in the codebase.
`;
  }

  /**
   * Main tool: Test the app end-to-end
   * Returns immediately and runs the pipeline in a background worker.
   */
  async handleTestMyApp(params) {
    const log = (msg) => console.error(`[Testbot] ${msg}`);

    // 1. Fast auto-detection (~100ms)
    log('Detecting project settings...');
    const detector = new AutoDetector();
    const context = await detector.detect(params.projectPath || process.cwd());

    log(`Project: ${context.projectName} (${context.language})`);
    log(`Path: ${context.projectPath}`);

    // 2. Merge params with detected context
    const config = {
      projectPath: context.projectPath,
      projectName: context.projectName,
      language: context.language,
      ecosystem: context.ecosystem,
      testType: params.testType || 'both',
      generateTests: params.generateTests !== false,
      prdFile: params.prdFile,
      codebaseContext: params.codebaseContext || null,
      baseURL: params.baseURL || context.baseURL,
      port: params.port || context.port,
      startCommand: params.startCommand || context.startCommand,
      jira: params.jira,
      openDashboard: params.openDashboard !== false,
    };

    // 3. Generate a unique run ID
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fs = require('fs');
    const statusDir = path.join(config.projectPath, 'testbot-reports', '.runs', runId);
    fs.mkdirSync(statusDir, { recursive: true });

    // Write initial status
    fs.writeFileSync(
      path.join(statusDir, 'status.json'),
      JSON.stringify({
        runId,
        phase: 'queued',
        timestamp: new Date().toISOString(),
        message: 'Pipeline queued, starting background worker...',
        project: config.projectName,
      }, null, 2)
    );

    // 4. Fork the background worker
    log(`Starting pipeline in background (runId: ${runId})...`);
    this.runPipelineInBackground(config, runId);

    // 5. Return immediately with status
    const dashboardUrl = process.env.TESTBOT_DASHBOARD_URL || 'http://localhost:3000';
    const statusFile = path.join(statusDir, 'status.json');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            status: 'started',
            runId,
            project: config.projectName,
            language: config.language,
            message: `TestBot pipeline started for "${config.projectName}". Tests are generating and running in the background.`,
            statusFile,
            dashboardUrl,
            nextSteps: [
              `Monitor progress: check ${statusFile}`,
              'Results will be posted to the webapp dashboard automatically when complete.',
              'The dashboard will open in your browser when tests finish.',
              `Dashboard URL: ${dashboardUrl}`,
            ],
          }, null, 2),
        },
      ],
    };
  }

  /**
   * Analyze existing test failures
   */
  async handleAnalyzeFailures(params) {
    const log = (msg) => console.error(`[Testbot] ${msg}`);

    const projectPath = params.projectPath || process.cwd();
    const testResultsPath = params.testResultsPath || `${projectPath}/test-results.json`;
    const aiProvider = params.aiProvider || process.env.AI_PROVIDER || 'sarvam';

    log(`Analyzing failures in ${testResultsPath}...`);

    const playwright = new PlaywrightIntegration({ projectPath });
    const testResults = await playwright.loadTestResults(testResultsPath);

    if (testResults.failed === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, message: 'No failures to analyze' }),
          },
        ],
      };
    }

    const analyzer = AIAnalyzer.create(aiProvider, process.env.SARVAM_API_KEY || process.env.AI_API_KEY);
    const analysis = await analyzer.analyzeFailures(testResults.failures);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            analyzed: analysis.length,
            analyses: analysis,
          }, null, 2),
        },
      ],
    };
  }

  /**
   * Generate report from existing test results
   */
  async handleGenerateReport(params) {
    const log = (msg) => console.error(`[Testbot] ${msg}`);

    const projectPath = params.projectPath || process.cwd();
    const testResultsPath = params.testResultsPath || `${projectPath}/test-results.json`;

    log(`Generating report from ${testResultsPath}...`);

    const playwright = new PlaywrightIntegration({ projectPath });
    const testResults = await playwright.loadTestResults(testResultsPath);

    const reportGen = new ReportGenerator();
    const report = await reportGen.generate({
      projectPath,
      projectName: require('path').basename(projectPath),
      testResults,
      aiAnalysis: null,
      jiraData: null,
      api_key: process.env.TESTBOT_API_KEY,
      dashboard_url: process.env.TESTBOT_DASHBOARD_URL || 'http://localhost:3000',
    });

    let dashboardUrl = null;
    if (params.openDashboard !== false) {
      dashboardUrl = await DashboardLauncher.open(report.path);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            reportPath: report.path,
            dashboardUrl,
          }, null, 2),
        },
      ],
    };
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Testbot MCP server started');
  }
}

// Start the server
const server = new TestbotMCPServer();
server.start().catch(console.error);
