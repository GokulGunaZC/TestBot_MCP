/**
 * OpenAI Test Generator
 * Orchestrates intelligent test generation using OpenAI GPT
 * Handles prompt engineering, chunked generation, and file output
 */

const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const OpenAIClient = require('./ai-providers/openai');
const Logger = require('./logger');

const GENERATED_TEST_FILE_SCHEMA = z.object({
  filename: z.string().min(1).max(180).optional(),
  content: z.string().min(1),
});

const GENERATED_TEST_ARRAY_SCHEMA = z.array(GENERATED_TEST_FILE_SCHEMA).min(1).max(20);

const FORBIDDEN_PATTERN_RULES = [
  { pattern: /xpath\s*=/i, reason: 'Avoid XPath selectors for deterministic and secure locators' },
  { pattern: /:nth-child\s*\(/i, reason: 'Avoid :nth-child selectors because they are brittle' },
  { pattern: /\.nth\(\d+\)/i, reason: 'Avoid locator.nth() assertions because DOM order is unstable' },
  { pattern: /waitForTimeout\s*\(/i, reason: 'Avoid fixed sleep; rely on deterministic waits/assertions' },
  { pattern: /Math\.random\s*\(/i, reason: 'Avoid random data generation in generated tests' },
  { pattern: /Date\.now\s*\(/i, reason: 'Avoid wall-clock dependent assertions' },
  { pattern: /new Date\(\)/i, reason: 'Avoid wall-clock dependent assertions' },
];

class OpenAITestGenerator {
  constructor(config = {}) {
    const envMaxTokens = Number.parseInt(process.env.OPENAI_MAX_TOKENS || '', 10);
    const envTemperature = Number.parseFloat(process.env.OPENAI_TEMPERATURE || '');
    const envMaxRetries = Number.parseInt(process.env.OPENAI_GENERATION_RETRIES || '', 10);
    const envRetryBackoffMs = Number.parseInt(process.env.OPENAI_RETRY_BACKOFF_MS || '', 10);

    this.config = {
      projectPath: config.projectPath || process.cwd(),
      outputDir: config.outputDir || 'tests/generated',
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      model: config.model || process.env.OPENAI_MODEL || 'gpt-4o',
      maxTokens: config.maxTokens || envMaxTokens || 4000,
      temperature: config.temperature ?? (Number.isFinite(envTemperature) ? envTemperature : 0.1),
      maxRetries: config.maxRetries ?? (Number.isFinite(envMaxRetries) ? envMaxRetries : 2),
      retryBackoffMs: config.retryBackoffMs ?? (Number.isFinite(envRetryBackoffMs) ? envRetryBackoffMs : 1200),
      maxPromptChars: config.maxPromptChars || 15000,
      fallbackOnFailure: config.fallbackOnFailure !== false,
      enforceValidation: config.enforceValidation !== false,
      ...config,
    };
    
    this.openai = null;
    this.generatedFiles = [];
  }

  /**
   * Initialize the OpenAI client
   */
  initialize() {
    if (!this.config.apiKey) {
      Logger.warn('OpenAITestGenerator', 'OpenAI API key missing; switching to deterministic fallback generation');
      return false;
    }
    
    this.openai = new OpenAIClient({
      apiKey: this.config.apiKey,
      model: this.config.model,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
    });
    
    Logger.info('OpenAITestGenerator', 'Initialized', {
      model: this.config.model,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      maxRetries: this.config.maxRetries,
    });
    return true;
  }

  /**
   * Generate tests from context, PRD, and user configuration
   * @param {Object} params - Generation parameters
   * @returns {Promise<Array>} Array of generated test files
   */
  async generateTests(params) {
    const {
      context = {},      // Auto-gathered codebase context
      prd,               // Product Requirements Document
      testType = 'both', // 'frontend', 'backend', or 'both'
      projectInfo = {},  // Project metadata (name, framework, baseURL)
      options = {},      // Additional options (includeSmoke, includeWorkflows, etc.)
    } = params;
    
    const isOpenAIReady = this.openai || this.initialize();
    Logger.info('OpenAITestGenerator', 'Starting test generation', {
      provider: isOpenAIReady ? 'openai' : 'fallback',
      testType,
    });
    
    this.generatedFiles = [];
    
    // Ensure output directory exists
    const outputDir = path.join(this.config.projectPath, this.config.outputDir);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Generate playwright.config.ts if not exists
    await this.ensurePlaywrightConfig(projectInfo);
    
    if (!isOpenAIReady && this.config.fallbackOnFailure) {
      await this.generateFallbackSuite(testType, context, projectInfo, options, outputDir, 'missing_api_key');
      return this.generatedFiles;
    }

    try {
      // 1. Generate smoke tests if enabled
      if (options.includeSmoke !== false) {
        Logger.info('OpenAITestGenerator', 'Generating smoke tests...');
        await this.generateSmokeTests(context, projectInfo, outputDir);
      }
      
      // 2. Generate page/frontend tests
      if (testType === 'frontend' || testType === 'both') {
        Logger.info('OpenAITestGenerator', 'Generating frontend tests...');
        await this.generateFrontendTests(context, prd, projectInfo, outputDir);
      }
      
      // 3. Generate API/backend tests
      if (testType === 'backend' || testType === 'both') {
        Logger.info('OpenAITestGenerator', 'Generating backend/API tests...');
        await this.generateBackendTests(context, prd, projectInfo, outputDir);
      }
      
      // 4. Generate workflow tests if enabled
      if (options.includeWorkflows !== false && context.workflows?.length > 0) {
        Logger.info('OpenAITestGenerator', 'Generating workflow tests...');
        await this.generateWorkflowTests(context, prd, projectInfo, outputDir);
      }
      
      // 5. Generate error state tests if enabled
      if (options.includeErrorStates && context.errorScenarios?.length > 0) {
        Logger.info('OpenAITestGenerator', 'Generating error state tests...');
        await this.generateErrorTests(context, projectInfo, outputDir);
      }

      if (this.generatedFiles.length === 0 && this.config.fallbackOnFailure) {
        Logger.warn('OpenAITestGenerator', 'No valid AI-generated tests after validation. Creating fallback suite.');
        await this.generateFallbackSuite(testType, context, projectInfo, options, outputDir, 'invalid_generation');
      }
      
      Logger.info('OpenAITestGenerator', `Generation complete`, { filesCreated: this.generatedFiles.length });
      
      return this.generatedFiles;
      
    } catch (error) {
      Logger.error('OpenAITestGenerator', `Generation failed`, error);
      throw error;
    }
  }

  /**
   * Ensure playwright.config.ts exists
   */
  async ensurePlaywrightConfig(projectInfo) {
    const configPaths = [
      'playwright.config.ts',
      'playwright.config.js',
    ];
    
    for (const configPath of configPaths) {
      if (fs.existsSync(path.join(this.config.projectPath, configPath))) {
        Logger.debug('OpenAITestGenerator', 'Playwright config already exists');
        return;
      }
    }
    
    // Generate basic config
    const config = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './${this.config.outputDir}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
    ['html', { open: 'never' }],
  ],
  use: {
    baseURL: '${projectInfo.baseURL || 'http://localhost:3000'}',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: ${projectInfo.startCommand ? `{
    command: '${projectInfo.startCommand}',
    url: '${projectInfo.baseURL || 'http://localhost:3000'}',
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  }` : 'undefined'},
});
`;
    
    const configPath = path.join(this.config.projectPath, 'playwright.config.ts');
    fs.writeFileSync(configPath, config, 'utf-8');
    Logger.info('OpenAITestGenerator', 'Created playwright.config.ts');
  }

  /**
   * Generate smoke tests
   */
  async generateSmokeTests(context, projectInfo, outputDir) {
    const systemPrompt = this.buildSmokeSystemPrompt();
    const userPrompt = this.buildSmokeUserPrompt(context, projectInfo);
    
    const tests = await this.callOpenAIForTests(systemPrompt, userPrompt, 'smoke');

    const finalTests = tests.length > 0
      ? tests
      : this.buildFallbackTestsForType('smoke', context, projectInfo, { reason: 'invalid_smoke_generation' });

    for (const test of finalTests) {
      await this.writeTestFile(test, outputDir);
    }
  }

  /**
   * Generate frontend tests
   */
  async generateFrontendTests(context, prd, projectInfo, outputDir) {
    // Group pages for chunked generation
    const pages = context.pages || [];
    
    if (pages.length === 0 && !prd) {
      Logger.warn('OpenAITestGenerator', 'No pages found and no PRD provided, skipping frontend tests');
      return;
    }
    
    const systemPrompt = this.buildFrontendSystemPrompt(projectInfo);
    const userPrompt = this.buildFrontendUserPrompt(context, prd, projectInfo);
    
    const tests = await this.callOpenAIForTests(systemPrompt, userPrompt, 'frontend');

    const finalTests = tests.length > 0
      ? tests
      : this.buildFallbackTestsForType('frontend', context, projectInfo, { reason: 'invalid_frontend_generation' });

    for (const test of finalTests) {
      await this.writeTestFile(test, outputDir);
    }
  }

  /**
   * Generate backend/API tests
   */
  async generateBackendTests(context, prd, projectInfo, outputDir) {
    const endpoints = context.apiEndpoints || [];
    
    if (endpoints.length === 0 && !prd) {
      Logger.warn('OpenAITestGenerator', 'No API endpoints found and no PRD provided, skipping backend tests');
      return;
    }
    
    const systemPrompt = this.buildBackendSystemPrompt(projectInfo);
    const userPrompt = this.buildBackendUserPrompt(context, prd, projectInfo);
    
    const tests = await this.callOpenAIForTests(systemPrompt, userPrompt, 'api');

    const finalTests = tests.length > 0
      ? tests
      : this.buildFallbackTestsForType('api', context, projectInfo, { reason: 'invalid_api_generation' });

    for (const test of finalTests) {
      await this.writeTestFile(test, outputDir);
    }
  }

  /**
   * Generate workflow tests
   */
  async generateWorkflowTests(context, prd, projectInfo, outputDir) {
    const workflows = context.workflows || [];
    
    if (workflows.length === 0) {
      return;
    }
    
    const systemPrompt = this.buildWorkflowSystemPrompt(projectInfo);
    const userPrompt = this.buildWorkflowUserPrompt(context, prd, projectInfo);
    
    const tests = await this.callOpenAIForTests(systemPrompt, userPrompt, 'workflow');

    const finalTests = tests.length > 0
      ? tests
      : this.buildFallbackTestsForType('workflow', context, projectInfo, { reason: 'invalid_workflow_generation' });

    for (const test of finalTests) {
      await this.writeTestFile(test, outputDir);
    }
  }

  /**
   * Generate error state tests
   */
  async generateErrorTests(context, projectInfo, outputDir) {
    const systemPrompt = this.buildErrorTestSystemPrompt(projectInfo);
    const userPrompt = this.buildErrorTestUserPrompt(context, projectInfo);
    
    const tests = await this.callOpenAIForTests(systemPrompt, userPrompt, 'error');

    const finalTests = tests.length > 0
      ? tests
      : this.buildFallbackTestsForType('error', context, projectInfo, { reason: 'invalid_error_generation' });

    for (const test of finalTests) {
      await this.writeTestFile(test, outputDir);
    }
  }

  /**
   * Build smoke test system prompt
   */
  buildSmokeSystemPrompt() {
    return `You are an expert Playwright test engineer. Generate comprehensive smoke tests that verify an application's basic health and functionality.

## Guidelines
- Use Playwright's @playwright/test framework with TypeScript
- Tests should be fast and reliable
- Focus on critical paths that indicate the app is working
- Include console error detection
- Test responsive design with different viewports
- Use proper async/await patterns
- Add descriptive test names and comments

## Output Format
Return a JSON array of test files:
[
  {
    "filename": "smoke.spec.ts",
    "content": "// Full test file content"
  }
]

IMPORTANT: Return ONLY valid JSON, no markdown code blocks or explanations.`;
  }

  /**
   * Build smoke test user prompt
   */
  buildSmokeUserPrompt(context, projectInfo) {
    return `Generate smoke tests for:

**Project**: ${projectInfo.name || 'App'}
**Base URL**: ${projectInfo.baseURL || 'http://localhost:3000'}
**Framework**: ${projectInfo.framework || 'Unknown'}

**Detected Pages** (${context.pages?.length || 0}):
${context.pages?.slice(0, 10).map(p => `- ${p.path}: ${p.description || ''}`).join('\n') || 'Home page only'}

Generate smoke tests that verify:
1. Application loads without errors
2. No console errors on initial load
3. Navigation between main pages works
4. Key UI elements are visible
5. Responsive design (mobile/tablet/desktop)
6. Basic interactive elements respond to clicks

Return as JSON array.`;
  }

  /**
   * Build frontend system prompt
   */
  buildFrontendSystemPrompt(projectInfo) {
    return `You are an expert Playwright test engineer specializing in frontend E2E testing. Generate comprehensive, production-ready tests.

## Guidelines
- Use Playwright's @playwright/test framework with TypeScript
- Include proper assertions (visibility, content, accessibility)
- Handle async operations with proper waits (avoid arbitrary timeouts)
- Test both happy paths and error scenarios
- Use accessible selectors (getByRole, getByLabel, getByText, getByTestId)
- Add meaningful comments explaining test logic
- Group related tests in describe blocks
- Include proper test isolation

## Framework: ${projectInfo.framework || 'React/Next.js'}
## Base URL: ${projectInfo.baseURL || 'http://localhost:3000'}

## Output Format
Return a JSON array of test files:
[
  {
    "filename": "page-name.spec.ts",
    "content": "// Full test file content with imports"
  }
]

IMPORTANT: Return ONLY valid JSON, no markdown code blocks.`;
  }

  /**
   * Build frontend user prompt
   */
  buildFrontendUserPrompt(context, prd, projectInfo) {
    let prompt = `Generate Playwright frontend tests.

## Project Info
- Name: ${projectInfo.name || 'App'}
- Base URL: ${projectInfo.baseURL || 'http://localhost:3000'}
- Framework: ${projectInfo.framework || 'Unknown'}
- TypeScript: ${context.projectStructure?.hasTypeScript ? 'Yes' : 'No'}

## Pages to Test (${context.pages?.length || 0})
`;
    
    if (context.pages?.length > 0) {
      for (const page of context.pages.slice(0, 10)) {
        prompt += `\n### ${page.path}
- Description: ${page.description || 'No description'}
- Components: ${page.components?.join(', ') || 'Unknown'}
- Interactions: ${page.interactions?.join(', ') || 'Unknown'}
`;
      }
    }
    
    if (context.forms?.length > 0) {
      prompt += `\n## Forms Detected (${context.forms.length})\n`;
      for (const form of context.forms.slice(0, 5)) {
        prompt += `- ${form.file}: ${form.fields?.length || 0} fields, validation: ${form.validationPatterns?.join(', ') || 'none'}\n`;
      }
    }
    
    if (context.componentDetails?.length > 0) {
      prompt += `\n## Key Components\n`;
      for (const comp of context.componentDetails.slice(0, 8)) {
        prompt += `- ${comp.name}: ${comp.props?.length || 0} props, handlers: ${comp.eventHandlers?.join(', ') || 'none'}\n`;
      }
    }
    
    if (prd) {
      prompt += `\n## Product Requirements (PRD)\n${prd}\n`;
    }
    
    prompt += `
## Test Coverage Requirements
1. Page load and initial state
2. User interactions (forms, buttons, links)
3. Navigation between pages
4. Form validation (if forms exist)
5. Error states and edge cases
6. Data display verification

Return as JSON array of test files.`;
    
    return prompt;
  }

  /**
   * Build backend system prompt
   */
  buildBackendSystemPrompt(projectInfo) {
    return `You are an expert API testing engineer. Generate comprehensive Playwright API tests.

## Guidelines
- Use Playwright's request API for HTTP calls
- Test all HTTP methods appropriately
- Validate response status codes, headers, and body structure
- Test authentication/authorization scenarios
- Include error cases (400, 401, 403, 404, 500)
- Test input validation
- Add proper test data management
- Include comments explaining each test

## Base URL: ${projectInfo.baseURL || 'http://localhost:3000'}

## Output Format
Return a JSON array of test files:
[
  {
    "filename": "api-resource.spec.ts",
    "content": "// Full test file content"
  }
]

IMPORTANT: Return ONLY valid JSON, no markdown code blocks.`;
  }

  /**
   * Build backend user prompt
   */
  buildBackendUserPrompt(context, prd, projectInfo) {
    let prompt = `Generate Playwright API tests.

## Project Info
- Base URL: ${projectInfo.baseURL || 'http://localhost:3000'}

## API Endpoints to Test (${context.apiEndpoints?.length || 0})
`;
    
    if (context.apiEndpoints?.length > 0) {
      for (const endpoint of context.apiEndpoints.slice(0, 15)) {
        prompt += `\n### ${endpoint.method} ${endpoint.path}
- Auth Required: ${endpoint.requiresAuth ? 'Yes' : 'No'}
`;
        if (endpoint.requestSchema) {
          prompt += `- Request Schema: ${JSON.stringify(endpoint.requestSchema)}\n`;
        }
        if (endpoint.responseSchema) {
          prompt += `- Response Schema: ${JSON.stringify(endpoint.responseSchema)}\n`;
        }
      }
    }
    
    if (context.apiSchemas?.length > 0) {
      prompt += `\n## Detected Schemas\n`;
      for (const schema of context.apiSchemas.slice(0, 5)) {
        prompt += `- ${schema.name} (${schema.type}): ${schema.fields?.map(f => f.name).join(', ') || 'no fields'}\n`;
      }
    }
    
    if (context.authPatterns?.length > 0) {
      prompt += `\n## Authentication\n`;
      for (const auth of context.authPatterns) {
        prompt += `- ${auth.type}: ${auth.description}\n`;
      }
    }
    
    if (prd) {
      prompt += `\n## Product Requirements (PRD)\n${prd}\n`;
    }
    
    prompt += `
## Test Coverage Requirements
1. Success responses with valid data
2. Validation errors with invalid data
3. Authentication tests (if auth required)
4. Authorization tests (access control)
5. Error handling (404, 500)
6. Response format and data integrity

Return as JSON array of test files.`;
    
    return prompt;
  }

  /**
   * Build workflow system prompt
   */
  buildWorkflowSystemPrompt(projectInfo) {
    return `You are an expert E2E testing engineer. Generate comprehensive workflow tests that simulate complete user journeys.

## Guidelines
- Test complete flows from start to finish
- Include both happy paths and error scenarios
- Handle async operations and page transitions
- Verify data persistence across steps
- Add proper cleanup in afterEach/afterAll
- Use proper test isolation
- Add detailed comments for each step

## Base URL: ${projectInfo.baseURL || 'http://localhost:3000'}

## Output Format
Return a JSON array of test files:
[
  {
    "filename": "workflow-name.spec.ts",
    "content": "// Full test file content"
  }
]

IMPORTANT: Return ONLY valid JSON, no markdown code blocks.`;
  }

  /**
   * Build workflow user prompt
   */
  buildWorkflowUserPrompt(context, prd, projectInfo) {
    let prompt = `Generate Playwright workflow tests.

## Workflows to Test (${context.workflows?.length || 0})
`;
    
    for (const workflow of context.workflows || []) {
      prompt += `\n### ${workflow.name}
- Description: ${workflow.description || 'No description'}
- Steps:
${workflow.steps?.map((s, i) => `  ${i + 1}. ${s}`).join('\n') || '  1. Navigate\n  2. Interact\n  3. Verify'}
`;
      if (workflow.criticalAssertions) {
        prompt += `- Critical Assertions: ${workflow.criticalAssertions.join(', ')}\n`;
      }
    }
    
    if (context.testDataSuggestions) {
      prompt += `\n## Test Data
${JSON.stringify(context.testDataSuggestions, null, 2)}
`;
    }
    
    if (prd) {
      prompt += `\n## Product Requirements (PRD)\n${prd}\n`;
    }
    
    prompt += `\nGenerate comprehensive workflow tests. Return as JSON array.`;
    
    return prompt;
  }

  /**
   * Build error test system prompt
   */
  buildErrorTestSystemPrompt(projectInfo) {
    return `You are an expert test engineer. Generate tests for error states and edge cases.

## Guidelines
- Test error handling and user feedback
- Verify error messages are clear and helpful
- Test boundary conditions
- Include network error scenarios
- Test form validation errors

## Output Format
Return a JSON array of test files:
[
  {
    "filename": "error-states.spec.ts",
    "content": "// Full test file content"
  }
]

IMPORTANT: Return ONLY valid JSON.`;
  }

  /**
   * Build error test user prompt
   */
  buildErrorTestUserPrompt(context, projectInfo) {
    let prompt = `Generate error state tests.

## Error Scenarios to Test
`;
    
    for (const scenario of context.errorScenarios || []) {
      prompt += `- ${scenario.scenario}: ${scenario.trigger} → ${scenario.expectedError}\n`;
    }
    
    prompt += `\nReturn as JSON array.`;
    
    return prompt;
  }

  /**
   * Call OpenAI to generate tests
   */
  async callOpenAIForTests(systemPrompt, userPrompt, prefix) {
    if (!this.openai) {
      return [];
    }

    const maxAttempts = Math.max(1, Number(this.config.maxRetries) + 1);
    const baseDelay = Math.max(200, Number(this.config.retryBackoffMs) || 1200);
    const hardenedSystemPrompt = this.sanitizePromptText(`${systemPrompt}\n\n${this.buildGenerationContract(prefix)}`);
    const hardenedUserPrompt = this.sanitizePromptText(userPrompt);
    const adaptiveMaxTokens = this.computeAdaptiveMaxTokens(hardenedSystemPrompt, hardenedUserPrompt);

    const previousMaxTokens = this.openai.config.maxTokens;
    const previousTemperature = this.openai.config.temperature;

    let lastError = null;
    let correctionPrompt = '';

    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          this.openai.config.maxTokens = adaptiveMaxTokens;
          this.openai.config.temperature = attempt === 0 ? this.config.temperature : 0;

          const messages = [
            { role: 'system', content: hardenedSystemPrompt },
            { role: 'user', content: hardenedUserPrompt },
          ];

          if (correctionPrompt) {
            messages.push({ role: 'user', content: correctionPrompt });
          }

          const response = await this.openai.callOpenAI(messages);
          const parsedFiles = this.parseTestResponse(response, prefix);

          if (parsedFiles.length > 0) {
            return parsedFiles;
          }

          throw new Error('No valid test files after schema and syntax validation');
        } catch (error) {
          lastError = error;
          const remainingAttempts = maxAttempts - attempt - 1;
          Logger.warn('OpenAITestGenerator', 'Generation attempt failed', {
            prefix,
            attempt: attempt + 1,
            maxAttempts,
            remainingAttempts,
            reason: error.message,
          });

          if (remainingAttempts > 0) {
            correctionPrompt = this.buildCorrectionPrompt(prefix, error.message);
            const delay = baseDelay * (2 ** attempt);
            await this.sleep(delay);
          }
        }
      }
    } finally {
      this.openai.config.maxTokens = previousMaxTokens;
      this.openai.config.temperature = previousTemperature;
    }

    Logger.error('OpenAITestGenerator', 'OpenAI call failed after retries', lastError);
    return [];
  }

  buildGenerationContract(prefix) {
    return `## Mandatory Response Contract
- Return only a JSON array. Do not use markdown or code fences.
- Schema (every entry is required):
  {"filename":"${prefix}-name.spec.ts","content":"full Playwright TypeScript test file"}
- filename must be a single file name (no slashes, no ".."), and end with ".spec.ts".
- content must contain at least one test(...) and at least one deterministic expect(...).
- Prefer secure selectors: getByRole/getByLabel/getByPlaceholder/getByTestId/getByText.
- Forbidden patterns: xpath selectors, waitForTimeout, nth-child selectors, Math.random, Date.now.
- Assertions must be deterministic (no wildcard regex like /.*/ for key assertions).`;
  }

  buildCorrectionPrompt(prefix, reason) {
    return `The previous ${prefix} response was rejected: ${reason}.
Regenerate and strictly follow the JSON schema and selector/assertion rules.
Return JSON array only.`;
  }

  sanitizePromptText(text) {
    const raw = typeof text === 'string' ? text : JSON.stringify(text || {});
    const withoutNullBytes = raw.replace(/\u0000/g, '');
    const withoutFences = withoutNullBytes.replace(/```/g, '` ` `');

    if (withoutFences.length <= this.config.maxPromptChars) {
      return withoutFences;
    }

    const truncated = withoutFences.slice(0, this.config.maxPromptChars);
    Logger.warn('OpenAITestGenerator', 'Prompt exceeded maxPromptChars and was truncated', {
      originalLength: withoutFences.length,
      truncatedLength: truncated.length,
    });
    return `${truncated}\n\n[TRUNCATED]`;
  }

  computeAdaptiveMaxTokens(systemPrompt, userPrompt) {
    const chars = (systemPrompt?.length || 0) + (userPrompt?.length || 0);
    const estimatedPromptTokens = Math.ceil(chars / 4);
    const desiredOutputTokens = Math.min(this.config.maxTokens, Math.max(1200, estimatedPromptTokens));
    return desiredOutputTokens;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Parse test response from OpenAI
   */
  parseTestResponse(response, prefix) {
    const content = typeof response === 'string' ? response.trim() : String(response || '').trim();
    if (!content) {
      throw new Error('Model returned empty content');
    }

    const parsed = this.extractStructuredTestArray(content);
    const schemaResult = GENERATED_TEST_ARRAY_SCHEMA.safeParse(parsed);
    if (!schemaResult.success) {
      throw new Error(`Generated payload failed schema validation: ${schemaResult.error.issues[0]?.message || 'unknown issue'}`);
    }

    const validFiles = [];
    const rejectedFiles = [];

    schemaResult.data.forEach((file, index) => {
      const filename = this.sanitizeFilename(file.filename, prefix, index);
      const normalizedContent = this.normalizeGeneratedContent(file.content);
      const qualityCheck = this.validateGeneratedContent(normalizedContent);
      const syntaxCheck = this.validateTypeScriptSyntax(normalizedContent, filename);

      if (!qualityCheck.valid || !syntaxCheck.valid) {
        rejectedFiles.push({
          filename,
          qualityErrors: qualityCheck.errors,
          syntaxErrors: syntaxCheck.errors,
        });
        return;
      }

      validFiles.push({
        filename,
        content: normalizedContent,
        type: prefix,
      });
    });

    if (rejectedFiles.length > 0) {
      Logger.warn('OpenAITestGenerator', 'Rejected invalid generated files', {
        prefix,
        rejected: rejectedFiles,
      });
    }

    if (validFiles.length === 0) {
      throw new Error('All generated files were rejected by schema/syntax/quality validation');
    }

    return validFiles;
  }

  extractStructuredTestArray(content) {
    const direct = this.tryParseJSON(content);
    if (Array.isArray(direct)) {
      return direct;
    }
    if (direct && Array.isArray(direct.files)) {
      return direct.files;
    }

    const fencedMatches = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
    for (const match of fencedMatches) {
      const parsed = this.tryParseJSON(match[1].trim());
      if (Array.isArray(parsed)) {
        return parsed;
      }
      if (parsed && Array.isArray(parsed.files)) {
        return parsed.files;
      }
    }

    const arrays = this.extractJsonArrayCandidates(content);
    for (const candidate of arrays) {
      const parsed = this.tryParseJSON(candidate);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }

    throw new Error('No valid JSON array found in model response');
  }

  tryParseJSON(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  extractJsonArrayCandidates(content) {
    const candidates = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let quoteChar = null;
    let escaping = false;

    for (let i = 0; i < content.length; i++) {
      const char = content[i];

      if (inString) {
        if (escaping) {
          escaping = false;
        } else if (char === '\\') {
          escaping = true;
        } else if (char === quoteChar) {
          inString = false;
          quoteChar = null;
        }
        continue;
      }

      if (char === '"' || char === "'") {
        inString = true;
        quoteChar = char;
        continue;
      }

      if (char === '[') {
        if (depth === 0) {
          start = i;
        }
        depth++;
      } else if (char === ']') {
        depth--;
        if (depth === 0 && start >= 0) {
          candidates.push(content.slice(start, i + 1));
          start = -1;
        }
      }
    }

    return candidates;
  }

  sanitizeFilename(rawFilename, prefix, index) {
    const fallbackName = `${prefix}-${index + 1}.spec.ts`;
    if (typeof rawFilename !== 'string' || rawFilename.trim() === '') {
      return fallbackName;
    }

    let candidate = path.basename(rawFilename.trim());
    candidate = candidate.replace(/[^\w.-]/g, '-');
    candidate = candidate.replace(/-+/g, '-').replace(/^\.+/, '').replace(/^\-+/, '');

    if (!candidate) {
      return fallbackName;
    }

    if (!candidate.endsWith('.spec.ts')) {
      if (candidate.endsWith('.ts') || candidate.endsWith('.js')) {
        candidate = candidate.replace(/\.(ts|js)$/i, '.spec.ts');
      } else {
        candidate = `${candidate}.spec.ts`;
      }
    }

    return candidate;
  }

  normalizeGeneratedContent(content) {
    if (typeof content !== 'string') {
      return '';
    }

    let normalized = content.trim();
    normalized = normalized.replace(/^```(?:typescript|ts|javascript|js)?\s*/i, '');
    normalized = normalized.replace(/\s*```$/i, '');
    normalized = normalized.replace(/\r\n/g, '\n');

    return normalized;
  }

  validateGeneratedContent(content) {
    const errors = [];

    if (!/\btest\s*\(/.test(content) && !/\btest\.describe\s*\(/.test(content)) {
      errors.push('Missing Playwright test definitions');
    }

    if (!/\bexpect\s*\(/.test(content)) {
      errors.push('Missing deterministic assertions (expect)');
    }

    if (/toHaveTitle\(\s*\/\.\*\/\s*\)/.test(content) || /toHaveURL\(\s*\/\.\*\/\s*\)/.test(content)) {
      errors.push('Contains wildcard assertion using /.*/ which is non-deterministic');
    }

    for (const rule of FORBIDDEN_PATTERN_RULES) {
      if (rule.pattern.test(content)) {
        errors.push(rule.reason);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  validateTypeScriptSyntax(content, filename) {
    if (!this.config.enforceValidation) {
      return { valid: true, errors: [] };
    }

    let ts;
    try {
      // Optional dependency in some environments
      ts = require('typescript');
    } catch {
      return { valid: true, errors: [] };
    }

    const transpileResult = ts.transpileModule(content, {
      fileName: filename,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
      },
    });

    const diagnostics = (transpileResult.diagnostics || []).filter(
      diagnostic => diagnostic.category === ts.DiagnosticCategory.Error
    );

    if (diagnostics.length === 0) {
      return { valid: true, errors: [] };
    }

    const errors = diagnostics.map(diagnostic =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    );

    return { valid: false, errors };
  }

  /**
   * Write test file to disk
   */
  async writeTestFile(test, outputDir) {
    const safeFilename = this.sanitizeFilename(test.filename, test.type || 'generated', this.generatedFiles.length);
    const filePath = path.resolve(outputDir, safeFilename);
    const resolvedOutputDir = path.resolve(outputDir);

    if (!filePath.startsWith(`${resolvedOutputDir}${path.sep}`) && filePath !== resolvedOutputDir) {
      throw new Error(`Unsafe output path detected for generated file: ${safeFilename}`);
    }
    
    // Add standard imports if missing
    let content = this.normalizeGeneratedContent(test.content);
    if (!content.includes("from '@playwright/test'")) {
      content = `import { test, expect } from '@playwright/test';\n\n${content}`;
    }
    
    fs.writeFileSync(filePath, content, 'utf-8');
    
    this.generatedFiles.push({
      path: filePath,
      filename: safeFilename,
      type: test.type,
    });
    
    Logger.info('OpenAITestGenerator', `Created test file`, { filename: safeFilename });
  }

  async generateFallbackSuite(testType, context, projectInfo, options, outputDir, reason) {
    const fallbackTypes = [];

    if (options.includeSmoke !== false) {
      fallbackTypes.push('smoke');
    }

    if (testType === 'frontend' || testType === 'both') {
      fallbackTypes.push('frontend');
    }

    if (testType === 'backend' || testType === 'both') {
      fallbackTypes.push('api');
    }

    if (options.includeWorkflows !== false && (context.workflows || []).length > 0) {
      fallbackTypes.push('workflow');
    }

    if (options.includeErrorStates && (context.errorScenarios || []).length > 0) {
      fallbackTypes.push('error');
    }

    const uniqueTypes = [...new Set(fallbackTypes)];
    for (const type of uniqueTypes) {
      const fallbackTests = this.buildFallbackTestsForType(type, context, projectInfo, { reason });
      for (const test of fallbackTests) {
        await this.writeTestFile(test, outputDir);
      }
    }
  }

  buildFallbackTestsForType(type, context, projectInfo, metadata = {}) {
    const reason = String(metadata.reason || 'fallback').replace(/\r?\n/g, ' ');
    const baseUrlComment = projectInfo.baseURL
      ? `// Base URL: ${String(projectInfo.baseURL).replace(/\r?\n/g, ' ')}`
      : '// Base URL provided via Playwright config';
    const routes = (context.pages || []).map(page => page.path).filter(Boolean).slice(0, 3);
    const fallbackRoutes = routes.length > 0 ? routes : ['/'];
    const endpoint = (context.apiEndpoints || []).find(item => String(item.method || 'GET').toUpperCase() === 'GET')
      || (context.apiEndpoints || [])[0];
    const endpointPath = String(endpoint?.path || '/');
    const endpointMethod = String(endpoint?.method || 'GET').toUpperCase();
    const workflowName = String(context.workflows?.[0]?.name || 'basic journey');
    const endpointCallMethod = endpointMethod === 'POST'
      ? 'post'
      : endpointMethod === 'PUT'
        ? 'put'
        : endpointMethod === 'DELETE'
          ? 'delete'
          : 'get';

    if (type === 'smoke') {
      return [{
        filename: 'fallback-smoke.spec.ts',
        type,
        content: `import { test, expect } from '@playwright/test';

${baseUrlComment}
// Fallback reason: ${reason}
test.describe('Fallback smoke checks', () => {
  test('root route responds and body is visible', async ({ page }) => {
    const response = await page.goto('/');
    expect(response).not.toBeNull();
    expect(response?.status()).toBeLessThan(500);
    await expect(page.locator('body')).toBeVisible();
  });
});
`,
      }];
    }

    if (type === 'frontend') {
      return [{
        filename: 'fallback-frontend.spec.ts',
        type,
        content: `import { test, expect } from '@playwright/test';

${baseUrlComment}
// Fallback reason: ${reason}
const routes = ${JSON.stringify(fallbackRoutes)};

test.describe('Fallback frontend checks', () => {
  for (const route of routes) {
    test(\`route \${route} renders body\`, async ({ page }) => {
      const response = await page.goto(route);
      expect(response).not.toBeNull();
      expect(response?.status()).toBeLessThan(500);
      await expect(page.locator('body')).toBeVisible();
    });
  }
});
`,
      }];
    }

    if (type === 'api') {
      return [{
        filename: 'fallback-api.spec.ts',
        type,
        content: `import { test, expect } from '@playwright/test';

${baseUrlComment}
// Fallback reason: ${reason}
test.describe('Fallback API checks', () => {
  test(${JSON.stringify(`${endpointMethod} ${endpointPath} does not return a server error`)}, async ({ request }) => {
    const response = await request.${endpointCallMethod}(${JSON.stringify(endpointPath)});
    expect(response.status()).toBeLessThan(500);
  });
});
`,
      }];
    }

    if (type === 'workflow') {
      return [{
        filename: 'fallback-workflow.spec.ts',
        type,
        content: `import { test, expect } from '@playwright/test';

${baseUrlComment}
// Fallback reason: ${reason}
test.describe('Fallback workflow checks', () => {
  test(${JSON.stringify(`${workflowName} basic navigation`)}, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();
  });
});
`,
      }];
    }

    if (type === 'error') {
      return [{
        filename: 'fallback-error.spec.ts',
        type,
        content: `import { test, expect } from '@playwright/test';

${baseUrlComment}
// Fallback reason: ${reason}
test.describe('Fallback error handling checks', () => {
  test('invalid route is handled without server error', async ({ page }) => {
    const response = await page.goto('/__testbot_invalid_route__');
    expect(response).not.toBeNull();
    expect(response?.status()).toBeLessThan(500);
    await expect(page.locator('body')).toBeVisible();
  });
});
`,
      }];
    }

    return [];
  }

  /**
   * Get summary of generated tests
   */
  getSummary() {
    return {
      totalFiles: this.generatedFiles.length,
      files: this.generatedFiles,
      outputDir: path.join(this.config.projectPath, this.config.outputDir),
      byType: {
        smoke: this.generatedFiles.filter(f => f.type === 'smoke').length,
        frontend: this.generatedFiles.filter(f => f.type === 'frontend').length,
        api: this.generatedFiles.filter(f => f.type === 'api').length,
        workflow: this.generatedFiles.filter(f => f.type === 'workflow').length,
        error: this.generatedFiles.filter(f => f.type === 'error').length,
      },
    };
  }
}

module.exports = OpenAITestGenerator;
