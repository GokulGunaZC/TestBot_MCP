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

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const AutoDetector = require('./auto-detector');
const PlaywrightIntegration = require('./playwright-integration');
const PlaywrightMCPClient = require('./playwright-mcp-client');
const PlaywrightMCPIntegration = require('./playwright-mcp-integration');
const ResultsMerger = require('./results-merger');
const ContextGatherer = require('./context-gatherer');
const AIAnalyzer = require('./ai-providers/index');
const JiraClient = require('./jira/client');
const ReportGenerator = require('./report-generator');
const DashboardLauncher = require('./dashboard-launcher');
const ConfigUILauncher = require('./config-ui-launcher');
const AgentContextRequester = require('./agent-context-requester');

class TestbotMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'testbot-mcp',
        version: '1.0.0',
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
          description: 'Test your application end-to-end with AI-powered analysis. Generates tests, runs them, analyzes failures with AI, and opens a beautiful dashboard with results. For best results, run testbot_configure first to get recommended settings.',
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
      
      log(`Detected project: ${context.projectName}`);
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
          framework: this.detectFramework(context),
          port: context.port,
          baseURL: context.baseURL,
          startCommand: context.startCommand,
          hasPlaywrightConfig: context.hasPlaywright,
          hasExistingTests: existingTests.count > 0,
          existingTestFiles: existingTests.files.slice(0, 10), // Show first 10
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
        // Check if README has requirements/features section
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
   */
  async handleTestMyApp(params) {
    const log = (msg) => console.error(`[Testbot] ${msg}`);

    try {
      // 1. Auto-detect project context
      log('Detecting project settings...');
      const detector = new AutoDetector();
      const context = await detector.detect(params.projectPath || process.cwd());

      log(`Project: ${context.projectName}`);
      log(`Path: ${context.projectPath}`);

      // Merge params with detected context
      const config = {
        projectPath: context.projectPath,
        projectName: context.projectName,
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

      // 2. Jira integration (optional)
      let jiraStories = null;
      if (config.jira?.enabled) {
        log('Fetching Jira stories...');
        const jiraClient = new JiraClient(config.jira);
        jiraStories = await jiraClient.fetchActiveStories();
        log(`Found ${jiraStories.length} active stories`);
      }

      // 3. Check existing tests FIRST
      const existingTests = this.scanExistingTests(config.projectPath);
      log(`Found ${existingTests.count} existing test files`);

      // 4. Gather codebase context
      let codebaseContext = config.codebaseContext;
      const contextGatherer = new ContextGatherer({ projectPath: config.projectPath });
      
      if (config.generateTests && !codebaseContext) {
        log('Gathering codebase context automatically...');
        codebaseContext = await contextGatherer.gatherRichContext();
        log(`Found ${codebaseContext.pages?.length || 0} pages, ${codebaseContext.apiEndpoints?.length || 0} API endpoints`);
      }

      // 5. Launch configuration UI to get mandatory user preferences and PRD
      log('Launching configuration UI mandatorily...');
      const configUI = new ConfigUILauncher({ port: 54321 });
      
      let prdContent = null;
      let userConfig = {
        includeSmoke: true,
        includeWorkflows: true, 
        includeErrorStates: false,
      };
      
      try {
        // Launch the UI and await User Submission
        const frameworkStr = codebaseContext && codebaseContext.projectStructure ? codebaseContext.projectStructure.framework : 'auto';
        const receivedConfig = await configUI.launch({
          projectPath: config.projectPath,
          projectName: config.projectName,
          framework: frameworkStr,
          baseURL: config.baseURL,
          port: config.port,
          startCommand: config.startCommand,
        });
        
        Object.assign(userConfig, receivedConfig);
        prdContent = userConfig.prd;
        
        if (userConfig.testType) config.testType = userConfig.testType;
        if (userConfig.baseURL) config.baseURL = userConfig.baseURL;
        
        log('User configuration received parameters successfully.');
      } catch (uiError) {
        log(`Config UI error / timeout: ${uiError.message}`);
        log('Falling back to default auto-generated test cases...');
      }

      // If a file was explicitly passed in the MCP tool args instead
      if (!prdContent && config.prdFile) {
        const fs = require('fs');
        try {
          prdContent = fs.readFileSync(config.prdFile, 'utf-8');
        } catch (error) {
          log(`Could not read PRD file: ${error.message}`);
        }
      }

      // 6. If NO tests exist, generate via TestBot SaaS backend
      if (existingTests.count === 0) {
        const testbotApiKey = process.env.TESTBOT_API_KEY;
        const dashboardUrl = process.env.TESTBOT_DASHBOARD_URL || 'http://localhost:3000';
        
        if (!testbotApiKey) {
          log('No TESTBOT_API_KEY set — cannot generate tests via SaaS backend.');
          log('Falling back to template-based test generation...');
          
          const playwrightMCP = new PlaywrightMCPClient(config);
          await playwrightMCP.generateTests({
            context: codebaseContext || { pages: [], apiEndpoints: [], workflows: [] },
            testType: config.testType,
            projectPath: config.projectPath,
          });
        } else {
          log('No existing tests found. Generating tests via TestBot backend...');
          
          // Try to get supplemental context from the AI agent
          const agentRequester = new AgentContextRequester({ projectPath: config.projectPath });
          const agentContext = await agentRequester.requestContext(codebaseContext);
          if (agentContext) {
            log('Merging auto-gathered context with agent insights...');
            codebaseContext = agentRequester.mergeContexts(codebaseContext, agentContext);
          }
          
          // Call the webapp /api/generate-tests endpoint
          log(`Calling ${dashboardUrl}/api/generate-tests ...`);
          
          const genResponse = await fetch(`${dashboardUrl}/api/generate-tests`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: testbotApiKey,
              context: codebaseContext || { pages: [], apiEndpoints: [], workflows: [] },
              testType: config.testType,
              prd: prdContent || '',
              projectInfo: {
                name: config.projectName,
                framework: codebaseContext?.projectStructure?.framework || 'Unknown',
                baseURL: config.baseURL,
              },
            }),
          });
          
          if (!genResponse.ok) {
            const errBody = await genResponse.json().catch(() => ({}));
            log(`Test generation API error: ${errBody.error || genResponse.status}`);
            log('Falling back to template-based test generation...');
            
            const playwrightMCP = new PlaywrightMCPClient(config);
            await playwrightMCP.generateTests({
              context: codebaseContext || { pages: [], apiEndpoints: [], workflows: [] },
              testType: config.testType,
              projectPath: config.projectPath,
            });
          } else {
            const genData = await genResponse.json();
            const generatedTests = genData.tests || [];
            
            log(`Received ${generatedTests.length} test file(s) from TestBot backend`);
            
            // Write test files to disk
            const fs = require('fs');
            const testsDir = path.join(config.projectPath, 'tests', 'generated');
            if (!fs.existsSync(testsDir)) {
              fs.mkdirSync(testsDir, { recursive: true });
            }
            
            for (const test of generatedTests) {
              const filePath = path.join(testsDir, test.filename);
              fs.writeFileSync(filePath, test.content, 'utf-8');
              log(`  Wrote: ${test.filename} (${test.type})`);
            }
          }
        }
      }

      // 6. Generate tests using template generator (if tests exist or OpenAI generation skipped)
      log('Setting up Playwright...');
      const playwright = new PlaywrightIntegration(config);
      const playwrightMCP = new PlaywrightMCPClient(config);
      
      // Re-check tests after potential generation
      const testsAfterGeneration = this.scanExistingTests(config.projectPath);
      
      // Generate additional tests if needed and we have context
      if (config.generateTests && (codebaseContext || config.prdFile || jiraStories) && testsAfterGeneration.count > 0) {
        log('Generating additional intelligent tests...');
        
        // Use PlaywrightMCPClient for additional test generation
        const generationResult = await playwrightMCP.generateTests({
          context: codebaseContext,
          testType: config.testType,
          projectPath: config.projectPath,
          prdFile: config.prdFile,
        });
        
        log(`Generated ${generationResult.generated} additional test files`);
        
        // Also generate from Jira stories if available
        if (jiraStories && jiraStories.length > 0) {
          log('Generating tests from Jira stories...');
          await playwright.generateTests({
            prdFile: config.prdFile,
            jiraStories,
            testType: config.testType,
          });
        }
      }

      // 5. Run tests (with optional parallel Playwright MCP execution)
      log('Running tests...');
      
      // Check if parallel MCP execution is enabled
      const mcpParallelEnabled = process.env.PLAYWRIGHT_MCP_PARALLEL === 'true' || 
                                  process.env.PLAYWRIGHT_MCP_ENABLED === 'true';
      
      let testResults;
      
      if (mcpParallelEnabled) {
        log('Parallel execution enabled - running TestBot + Playwright MCP...');
        
        // Create Playwright MCP integration
        const playwrightMCPIntegration = new PlaywrightMCPIntegration({
          projectPath: config.projectPath,
          baseURL: config.baseURL,
        });
        
        // Run tests in parallel
        const [directResults, mcpResults] = await Promise.all([
          playwright.runTests(),                    // Fast direct execution
          playwrightMCPIntegration.runTests()       // Full artifact capture
        ]);
        
        log(`Direct execution: ${directResults.total} tests`);
        log(`MCP execution: ${mcpResults.available !== false ? mcpResults.total : 'unavailable'} tests`);
        
        // Merge results from both sources
        const merger = new ResultsMerger({ projectPath: config.projectPath });
        testResults = merger.mergeResults(directResults, mcpResults);
        
        // Log merged artifacts
        if (testResults.artifacts) {
          const artifacts = testResults.artifacts;
          log(`Collected artifacts: ${artifacts.screenshots?.length || 0} screenshots, ${artifacts.videos?.length || 0} videos, ${artifacts.traces?.length || 0} traces`);
        }
      } else {
        // Standard single execution
        testResults = await playwright.runTests();
      }

      log(`Tests completed: ${testResults.total} total, ${testResults.passed} passed, ${testResults.failed} failed`);

      // 5. AI analysis on failures (skipped — analysis can be done on the webapp dashboard)
      let aiAnalysis = null;

      // 6. Generate report
      log('Generating report...');
      const reportGen = new ReportGenerator();

      // Log dashboard sync intent (actual posting happens inside ReportGenerator)
      const testbotApiKey = process.env.TESTBOT_API_KEY;
      const testbotDashboardUrl =
        process.env.TESTBOT_DASHBOARD_URL || 'http://localhost:3000';
      if (testbotApiKey) {
        log(`Dashboard sync enabled — will post results to ${testbotDashboardUrl}`);
      } else {
        log('TESTBOT_API_KEY not set — skipping web dashboard sync');
      }

      const report = await reportGen.generate({
        projectPath: config.projectPath,
        projectName: config.projectName,
        testResults,
        aiAnalysis,
        jiraData: jiraStories,
        api_key: testbotApiKey,
        dashboard_url: testbotDashboardUrl
      });

      // 7. Open dashboard
      let dashboardUrl = null;
      if (config.openDashboard) {
        log('Opening dashboard...');
        dashboardUrl = await DashboardLauncher.open(report.path);
      }

      // Return summary
      const summary = {
        success: true,
        project: config.projectName,
        summary: {
          total: testResults.total,
          passed: testResults.passed,
          failed: testResults.failed,
          skipped: testResults.skipped,
          duration: `${testResults.duration}ms`,
          passRate: testResults.total > 0
            ? `${Math.round((testResults.passed / testResults.total) * 100)}%`
            : '0%',
        },
        reportPath: report.path,
        dashboardUrl,
        aiAnalysis: aiAnalysis
          ? {
              analyzed: aiAnalysis.length,
              highConfidence: aiAnalysis.filter((a) => a.confidence > 0.8).length,
            }
          : null,
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    } catch (error) {
      log(`Error: ${error.message}`);
      throw error;
    }
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
