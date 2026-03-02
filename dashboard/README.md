# Testbot Dashboard

A beautiful dashboard for viewing Testbot MCP test results.

## Features

- KPI cards with pass/fail statistics
- AI analysis summary carousel
- Suite breakdown with charts
- Filterable, sortable test table
- Screenshot/video viewers
- Regression comparison

## Usage

The dashboard is automatically opened by Testbot MCP after test runs.

To open manually:

```bash
open public/index.html
```

Or serve with any static file server:

```bash
npx serve public
```

## Report Format

The dashboard expects a `report.json` file in the `public` directory with this structure:

```json
{
  "metadata": {
    "timestamp": "2025-01-27T...",
    "projectName": "My App"
  },
  "stats": {
    "total": 10,
    "passed": 8,
    "failed": 2
  },
  "tests": [...]
}
```

See the [API Reference](../docs/API_REFERENCE.md) for full schema.
