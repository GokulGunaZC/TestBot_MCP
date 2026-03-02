# Testbot MCP API Reference

Complete reference for Testbot MCP tools and parameters.

## MCP Tools

Testbot exposes the following MCP tools:

### testbot_test_my_app

Main testing tool - runs tests with full workflow.

**Description**: Test your application end-to-end with AI-powered analysis.

**Parameters**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `projectPath` | string | No | workspace root | Path to the project to test |
| `testType` | string | No | `"both"` | Type of tests: `"frontend"`, `"backend"`, or `"both"` |
| `prdFile` | string | No | - | Path to PRD file for test generation |
| `baseURL` | string | No | auto-detected | Base URL for the application |
| `port` | number | No | auto-detected | Port number the app runs on |
| `startCommand` | string | No | auto-detected | Command to start the app server |
| `aiProvider` | string | No | `"sarvam"` | AI provider: `"sarvam"`, `"cascade"`, `"windsurf"`, `"none"` |
| `aiApiKey` | string | No | from env | API key for the AI provider |
| `jira` | object | No | - | Jira integration configuration |
| `jira.enabled` | boolean | No | false | Enable Jira integration |
| `jira.baseUrl` | string | No | from env | Jira instance URL |
| `jira.email` | string | No | from env | Jira account email |
| `jira.apiToken` | string | No | from env | Jira API token |
| `jira.projectKey` | string | No | from env | Jira project key |
| `openDashboard` | boolean | No | true | Auto-open dashboard after tests |

**Returns**:

```json
{
  "success": true,
  "project": "my-app",
  "summary": {
    "total": 25,
    "passed": 23,
    "failed": 2,
    "skipped": 0,
    "duration": "45000ms",
    "passRate": "92%"
  },
  "reportPath": "/path/to/report.json",
  "dashboardUrl": "file:///path/to/dashboard/index.html",
  "aiAnalysis": {
    "analyzed": 2,
    "highConfidence": 1
  }
}
```

**Example Usage**:

```javascript
// Via MCP
{
  "name": "testbot_test_my_app",
  "arguments": {
    "projectPath": "/path/to/project",
    "testType": "frontend",
    "aiProvider": "sarvam"
  }
}
```

---

### testbot_analyze_failures

Analyze existing test failures without running new tests.

**Description**: Analyze test failures with AI analysis.

**Parameters**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `projectPath` | string | Yes | - | Path to the project |
| `testResultsPath` | string | No | `{projectPath}/test-results.json` | Path to test results file |
| `aiProvider` | string | No | `"sarvam"` | AI provider for analysis |

**Returns**:

```json
{
  "success": true,
  "analyzed": 5,
  "analyses": [
    {
      "testName": "should login successfully",
      "file": "tests/auth.spec.js",
      "analysis": "The test failed because...",
      "rootCause": "Missing selector...",
      "confidence": 0.95,
      "suggestedFix": {
        "description": "Update the selector...",
        "changes": [...]
      }
    }
  ]
}
```

---

### testbot_generate_report

Generate a dashboard report from existing test results.

**Description**: Create a visual report without running tests.

**Parameters**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `projectPath` | string | Yes | - | Path to the project |
| `testResultsPath` | string | No | `{projectPath}/test-results.json` | Path to test results file |
| `openDashboard` | boolean | No | true | Auto-open dashboard |

**Returns**:

```json
{
  "success": true,
  "reportPath": "/path/to/report.json",
  "dashboardUrl": "file:///path/to/dashboard/index.html"
}
```

---

## Report Format

The generated report follows this JSON schema:

```typescript
interface TestbotReport {
  metadata: {
    timestamp: string;          // ISO 8601 timestamp
    projectName: string;
    projectPath: string;
    version: string;            // Testbot version
    generator: "testbot-mcp";
  };
  
  stats: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    duration: number;           // milliseconds
    passRate: number;           // percentage (0-100)
  };
  
  tests: TestResult[];
  
  aiSummary?: {
    total: number;
    highConfidence: number;
    mediumConfidence: number;
    lowConfidence: number;
    analyses: AnalysisSummary[];
  };
  
  jiraSummary?: {
    total: number;
    stories: JiraStorySummary[];
  };
}

interface TestResult {
  id: string;
  title: string;
  suite: string;
  file: string;
  status: "passed" | "failed" | "skipped";
  duration: number;
  error?: {
    message: string;
    stack?: string;
  };
  retries: number;
  attachments: {
    screenshots: Attachment[];
    videos: Attachment[];
    traces: Attachment[];
  };
  aiAnalysis?: AIAnalysis;
  jiraStory?: {
    key: string;
    summary: string;
    status: string;
    priority: string;
  };
}

interface AIAnalysis {
  analysis: string;
  rootCause: string;
  suggestedFix: {
    description: string;
    changes: CodeChange[];
  };
  confidence: number;          // 0.0 to 1.0
  affectedFiles: string[];
  testingRecommendations: string;
  aiProvider: string;
  model: string;
}

interface CodeChange {
  file: string;
  action: "replace" | "insert" | "delete";
  lineStart?: number;
  lineEnd?: number;
  oldCode?: string;
  newCode?: string;
}
```

---

## Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `AI_PROVIDER` | AI provider name | No | `"sarvam"` |
| `SARVAM_API_KEY` | Sarvam AI API key | If using Sarvam | - |
| `AI_API_KEY` | Generic AI API key | No | - |
| `AI_MODEL` | AI model name | No | Provider default |
| `JIRA_BASE_URL` | Jira instance URL | If using Jira | - |
| `JIRA_EMAIL` | Jira account email | If using Jira | - |
| `JIRA_API_TOKEN` | Jira API token | If using Jira | - |
| `JIRA_PROJECT_KEY` | Jira project key | If using Jira | - |

---

## Error Handling

All tools return errors in this format:

```json
{
  "content": [{
    "type": "text",
    "text": "Error: {message}\n{stack}"
  }],
  "isError": true
}
```

Common error codes:

| Error | Cause | Solution |
|-------|-------|----------|
| `No test results found` | Tests haven't been run | Run tests first |
| `API key required` | Missing AI API key | Set `SARVAM_API_KEY` |
| `Jira API error` | Invalid Jira credentials | Check Jira settings |
| `Playwright not found` | Missing dependency | Run `npm install` |
