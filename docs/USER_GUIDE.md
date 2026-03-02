# Testbot MCP User Guide

Complete guide to using Testbot MCP for automated testing.

## Table of Contents

1. [Installation](#installation)
2. [Configuration](#configuration)
3. [Running Tests](#running-tests)
4. [AI Analysis](#ai-analysis)
5. [Dashboard](#dashboard)
6. [Jira Integration](#jira-integration)
7. [Test Generation](#test-generation)
8. [Advanced Usage](#advanced-usage)

## Installation

### Global Installation

```bash
npm install -g @testbot/mcp
```

### Local Installation

```bash
npm install -D @testbot/mcp
```

### Verify Installation

```bash
npx @testbot/mcp --version
```

## Configuration

### MCP Configuration

Add Testbot to your IDE's MCP configuration:

```json
{
  "mcpServers": {
    "testbot": {
      "command": "npx",
      "args": ["@testbot/mcp"],
      "env": {
        "SARVAM_API_KEY": "your-api-key",
        "AI_PROVIDER": "sarvam"
      }
    }
  }
}
```

### Environment Variables

Create a `.env` file in your project:

```bash
# AI Configuration
AI_PROVIDER=sarvam
SARVAM_API_KEY=your-api-key

# Jira Configuration (optional)
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=your@email.com
JIRA_API_TOKEN=your-token
JIRA_PROJECT_KEY=MYAPP
```

### Auto-Detection

Testbot automatically detects:

| Setting | Detection Source |
|---------|-----------------|
| Project Name | `package.json` name field |
| Port | `PORT` env var, `package.json` scripts, framework defaults |
| Base URL | `playwright.config.js`, `.env`, constructed from port |
| Start Command | `package.json` scripts (`dev`, `start`, `serve`) |
| Test Directory | `tests/`, `test/`, `__tests__/`, `spec/` |

## Running Tests

### Basic Test Run

```
User: "Test my app using testbot mcp"
```

### Frontend Only

```
User: "Test my frontend using testbot mcp"
```

### Backend Only

```
User: "Test my backend using testbot mcp"
```

### With Specific Configuration

```
User: "Test my app using testbot mcp on port 3000 with base URL http://localhost:3000"
```

## AI Analysis

### Supported Providers

| Provider | Model | Best For |
|----------|-------|----------|
| Sarvam | sarvam-m | General purpose, multilingual |
| Cascade | codex-5.1 | Deep code analysis |
| Windsurf | cascade | IDE integration |

### Enable AI Analysis

```
User: "Test my app with sarvam AI analysis"
```

### Disable AI Analysis

```
User: "Test my app without AI analysis"
```

### Analysis Output

Each failed test gets:
- **What & Why**: Explanation of the failure
- **Root Cause**: Underlying issue
- **Suggested Fix**: Code changes to fix
- **Confidence Score**: 0-100%
- **Affected Files**: Files that need changes

## Dashboard

### Opening the Dashboard

The dashboard opens automatically after tests complete. To prevent this:

```
User: "Test my app without opening dashboard"
```

### Dashboard Features

1. **KPI Cards**
   - Total tests, passed, failed, skipped
   - Pass rate with progress bar
   - Total duration

2. **AI Summary Carousel**
   - Navigate through failure analyses
   - View root causes and fixes
   - See confidence scores

3. **Suite Breakdown**
   - Results grouped by test suite
   - Pass rate per suite

4. **Test Table**
   - Filter by status
   - Search by name
   - Sort by any column
   - Click for details

5. **Regression Comparison**
   - Compare with baseline
   - Track improvements/degradation

### Test Details Modal

Click "Details" on any test to see:
- Full error message and stack trace
- AI analysis (if available)
- Screenshots
- Video recording
- Trace files

## Jira Integration

### Setup

Set environment variables:

```bash
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=your@email.com
JIRA_API_TOKEN=your-api-token
JIRA_PROJECT_KEY=MYAPP
```

### Usage

```
User: "Test my app with Jira integration"
```

Testbot will:
1. Fetch active stories (not Done)
2. Extract acceptance criteria
3. Generate tests from criteria
4. Run tests
5. Link results to Jira stories

### Acceptance Criteria Format

Testbot parses Gherkin-style criteria:

```
## Acceptance Criteria

- Given I am on the login page
- When I enter valid credentials
- Then I should be logged in
```

## Test Generation

### From PRD

```
User: "Test my app with PRD at ./docs/requirements.md"
```

PRD format:

```markdown
# Feature: User Login

## Scenario: Successful login
- Given I am on the login page
- When I enter valid credentials
- Then I should see the dashboard

## Scenario: Failed login
- Given I am on the login page
- When I enter invalid credentials
- Then I should see an error message
```

### From Jira Stories

Tests are generated from Jira acceptance criteria:

```
Story: MYAPP-123 - User Login
Acceptance Criteria:
- Given I am on the login page
- When I enter valid credentials
- Then I should be logged in
```

Generated test:

```javascript
test.describe('MYAPP-123: User Login', () => {
  test('should log in with valid credentials', async ({ page }) => {
    await page.goto('/login');
    // ... generated test code
  });
});
```

## Advanced Usage

### Custom Playwright Config

If you have a `playwright.config.js`, Testbot uses it:

```javascript
// playwright.config.js
module.exports = {
  testDir: './tests',
  baseURL: 'http://localhost:3000',
  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  }
};
```

### Running Specific Tests

```
User: "Run only login tests using testbot mcp"
```

### Analyzing Existing Results

```
User: "Analyze test failures with testbot mcp"
```

### Generating Report Only

```
User: "Generate dashboard report from test-results.json"
```

## Best Practices

1. **Keep Tests Fast**: Use fixtures and mocks
2. **Write Clear Assertions**: Make failures easy to understand
3. **Use Descriptive Names**: Help AI analysis
4. **Include Screenshots**: Configure Playwright to capture on failure
5. **Organize by Feature**: Group related tests in suites
