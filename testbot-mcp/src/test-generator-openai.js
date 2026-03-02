/**
 * OpenAI Test Generator
 * Orchestrates intelligent test generation using OpenAI GPT
 * Handles prompt engineering, chunked generation, and file output
 */

const fs = require('fs');
const path = require('path');
const OpenAIClient = require('./ai-providers/openai');

class OpenAITestGenerator {
  constructor(config = {}) {
    this.config = {
      projectPath: config.projectPath || process.cwd(),
      outputDir: config.outputDir || 'tests/generated',
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      model: config.model || process.env.OPENAI_MODEL || 'gpt-4o',
      maxTokens: config.maxTokens || 4000,
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
      throw new Error(
        '❌ OpenAI API key not found!\n\n' +
        'To enable test generation, add to your project\'s .env file:\n' +
        'OPENAI_API_KEY=sk-proj-...\n\n' +
        'Get your key at: https://platform.openai.com/api-keys'
      );
    }
    
    this.openai = new OpenAIClient({
      apiKey: this.config.apiKey,
      model: this.config.model,
      maxTokens: this.config.maxTokens,
    });
    
    console.error(`[TestGenerator] Initialized with model: ${this.config.model}`);
  }

  /**
   * Generate tests from context, PRD, and user configuration
   * @param {Object} params - Generation parameters
   * @returns {Promise<Array>} Array of generated test files
   */
  async generateTests(params) {
    const {
      context,           // Auto-gathered codebase context
      prd,               // Product Requirements Document
      testType,          // 'frontend', 'backend', or 'both'
      projectInfo,       // Project metadata (name, framework, baseURL)
      options = {},      // Additional options (includeSmoke, includeWorkflows, etc.)
    } = params;

    const log = (msg) => console.error(`[TestGenerator] ${msg}`);
    
    if (!this.openai) {
      this.initialize();
    }
    
    log('Starting test generation with OpenAI...');
    
    this.generatedFiles = [];
    
    // Ensure output directory exists
    const outputDir = path.join(this.config.projectPath, this.config.outputDir);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Generate playwright.config.ts if not exists
    await this.ensurePlaywrightConfig(projectInfo);
    
    try {
      // 1. Generate smoke tests if enabled
      if (options.includeSmoke !== false) {
        log('Generating smoke tests...');
        await this.generateSmokeTests(context, projectInfo, outputDir);
      }
      
      // 2. Generate page/frontend tests
      if (testType === 'frontend' || testType === 'both') {
        log('Generating frontend tests...');
        await this.generateFrontendTests(context, prd, projectInfo, outputDir);
      }
      
      // 3. Generate API/backend tests
      if (testType === 'backend' || testType === 'both') {
        log('Generating backend/API tests...');
        await this.generateBackendTests(context, prd, projectInfo, outputDir);
      }
      
      // 4. Generate workflow tests if enabled
      if (options.includeWorkflows !== false && context.workflows?.length > 0) {
        log('Generating workflow tests...');
        await this.generateWorkflowTests(context, prd, projectInfo, outputDir);
      }
      
      // 5. Generate error state tests if enabled
      if (options.includeErrorStates && context.errorScenarios?.length > 0) {
        log('Generating error state tests...');
        await this.generateErrorTests(context, projectInfo, outputDir);
      }
      
      log(`Generation complete: ${this.generatedFiles.length} test file(s) created`);
      
      return this.generatedFiles;
      
    } catch (error) {
      log(`Generation failed: ${error.message}`);
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
        console.error('[TestGenerator] Playwright config already exists');
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
    console.error('[TestGenerator] Created playwright.config.ts');
  }

  /**
   * Generate smoke tests
   */
  async generateSmokeTests(context, projectInfo, outputDir) {
    const systemPrompt = this.buildSmokeSystemPrompt();
    const userPrompt = this.buildSmokeUserPrompt(context, projectInfo);
    
    const tests = await this.callOpenAIForTests(systemPrompt, userPrompt, 'smoke');
    
    for (const test of tests) {
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
      console.error('[TestGenerator] No pages found and no PRD provided, skipping frontend tests');
      return;
    }
    
    const systemPrompt = this.buildFrontendSystemPrompt(projectInfo);
    const userPrompt = this.buildFrontendUserPrompt(context, prd, projectInfo);
    
    const tests = await this.callOpenAIForTests(systemPrompt, userPrompt, 'frontend');
    
    for (const test of tests) {
      await this.writeTestFile(test, outputDir);
    }
  }

  /**
   * Generate backend/API tests
   */
  async generateBackendTests(context, prd, projectInfo, outputDir) {
    const endpoints = context.apiEndpoints || [];
    
    if (endpoints.length === 0 && !prd) {
      console.error('[TestGenerator] No API endpoints found and no PRD provided, skipping backend tests');
      return;
    }
    
    const systemPrompt = this.buildBackendSystemPrompt(projectInfo);
    const userPrompt = this.buildBackendUserPrompt(context, prd, projectInfo);
    
    const tests = await this.callOpenAIForTests(systemPrompt, userPrompt, 'api');
    
    for (const test of tests) {
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
    
    for (const test of tests) {
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
    
    for (const test of tests) {
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
    try {
      const response = await this.openai.callOpenAI([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]);
      
      return this.parseTestResponse(response, prefix);
    } catch (error) {
      console.error(`[TestGenerator] OpenAI call failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Parse test response from OpenAI
   */
  parseTestResponse(response, prefix) {
    try {
      const content = typeof response === 'string' ? response.trim() : response;
      
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch {
        // Try to extract JSON from markdown
        const jsonMatch = content.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[1]);
        } else {
          const arrayMatch = content.match(/(\[[\s\S]*\])/);
          if (arrayMatch) {
            parsed = JSON.parse(arrayMatch[1]);
          } else {
            throw new Error('No valid JSON found');
          }
        }
      }
      
      if (!Array.isArray(parsed)) {
        parsed = [parsed];
      }
      
      return parsed.map((file, index) => ({
        filename: file.filename || `${prefix}-${index + 1}.spec.ts`,
        content: file.content || '',
        type: prefix,
      })).filter(f => f.content.length > 0);
      
    } catch (error) {
      console.error(`[TestGenerator] Failed to parse response: ${error.message}`);
      return [];
    }
  }

  /**
   * Write test file to disk
   */
  async writeTestFile(test, outputDir) {
    const filePath = path.join(outputDir, test.filename);
    
    // Add standard imports if missing
    let content = test.content;
    if (!content.includes("from '@playwright/test'")) {
      content = `import { test, expect } from '@playwright/test';\n\n${content}`;
    }
    
    fs.writeFileSync(filePath, content, 'utf-8');
    
    this.generatedFiles.push({
      path: filePath,
      filename: test.filename,
      type: test.type,
    });
    
    console.error(`[TestGenerator] Created: ${test.filename}`);
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
