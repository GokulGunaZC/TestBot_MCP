# Testbot MCP Quick Start Guide

Get up and running with Testbot MCP in 5 minutes.

## Prerequisites

- Node.js 18+
- Cursor, Windsurf, or another MCP-compatible IDE
- A web application to test

## Step 1: Install Testbot MCP

```bash
npm install -g @testbot/mcp
```

Or install locally in your project:

```bash
npm install -D @testbot/mcp
```

## Step 2: Configure Your IDE

### For Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "testbot": {
      "command": "npx",
      "args": ["@testbot/mcp"],
      "env": {
        "SARVAM_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### For Windsurf

Add to your Windsurf MCP configuration:

```json
{
  "mcpServers": {
    "testbot": {
      "command": "npx",
      "args": ["@testbot/mcp"]
    }
  }
}
```

## Step 3: Test Your App

Open your project in your IDE and say:

> "Test my app using testbot mcp"

Testbot will:
1. Detect your project settings
2. Run tests
3. Analyze any failures
4. Open the results dashboard

## Step 4: View Results

The dashboard automatically opens showing:

- Pass/fail statistics
- AI analysis of failures
- Screenshots and videos
- Detailed error information

## Quick Examples

### Test Frontend Only

> "Test my frontend using testbot mcp"

### Test with AI Analysis

> "Test my app using testbot mcp with sarvam AI"

### Test from PRD

> "Test my app using testbot mcp with the PRD at ./docs/prd.md"

### Test without Dashboard

> "Test my app using testbot mcp without opening dashboard"

## Troubleshooting

### "MCP server not found"

Make sure Testbot is installed and the path is correct in your MCP config.

### "No tests found"

Ensure your project has:
- A `tests/` directory with `.spec.js` files, OR
- A PRD file specified, OR
- Jira integration configured

### "AI analysis failed"

Check that your API key is set correctly:

```bash
echo $SARVAM_API_KEY
```

## Next Steps

- Read the [User Guide](USER_GUIDE.md) for advanced features
- Check the [API Reference](API_REFERENCE.md) for all options
- Set up [Jira Integration](USER_GUIDE.md#jira-integration) for automatic test generation
