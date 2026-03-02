#!/bin/bash

# Dashboard Fix Script
# Forces the dashboard to show the latest report by copying it directly
# and opening with aggressive cache-busting

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  TestBot Dashboard Fix Tool${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Find the QA_Final directory (script's parent)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
QA_FINAL_DIR="$(dirname "$SCRIPT_DIR")"

DASHBOARD_DIR="$QA_FINAL_DIR/dashboard/public"
REPORT_PATH="$DASHBOARD_DIR/report.json"
METADATA_PATH="$DASHBOARD_DIR/report-metadata.json"

echo -e "${BLUE}[INFO]${NC} QA_Final directory: $QA_FINAL_DIR"
echo -e "${BLUE}[INFO]${NC} Dashboard directory: $DASHBOARD_DIR"
echo ""

# Check if dashboard directory exists
if [ ! -d "$DASHBOARD_DIR" ]; then
    echo -e "${RED}[ERROR]${NC} Dashboard directory not found: $DASHBOARD_DIR"
    exit 1
fi

# Get project path from argument or try to find recent reports
PROJECT_PATH="${1:-}"

if [ -z "$PROJECT_PATH" ]; then
    echo -e "${YELLOW}[WARN]${NC} No project path provided, looking for recent reports..."
    
    # Check if there's a metadata file that points to the source
    if [ -f "$METADATA_PATH" ]; then
        SOURCE_REPORT=$(cat "$METADATA_PATH" | grep -o '"sourceReport"[^,]*' | cut -d'"' -f4)
        if [ -n "$SOURCE_REPORT" ] && [ -f "$SOURCE_REPORT" ]; then
            PROJECT_PATH=$(dirname $(dirname "$SOURCE_REPORT"))
            echo -e "${BLUE}[INFO]${NC} Found source from metadata: $PROJECT_PATH"
        fi
    fi
fi

# Look for latest.json in the project
LATEST_REPORT=""
if [ -n "$PROJECT_PATH" ] && [ -d "$PROJECT_PATH/testbot-reports" ]; then
    LATEST_REPORT="$PROJECT_PATH/testbot-reports/latest.json"
fi

# Validate report
echo -e "${BLUE}[STEP 1]${NC} Checking report status..."
echo ""

if [ -f "$REPORT_PATH" ]; then
    REPORT_SIZE=$(stat -f%z "$REPORT_PATH" 2>/dev/null || stat --printf="%s" "$REPORT_PATH" 2>/dev/null)
    echo -e "${GREEN}[OK]${NC} Current report.json exists (${REPORT_SIZE} bytes)"
    
    # Check test count
    TEST_COUNT=$(cat "$REPORT_PATH" | grep -o '"total":[0-9]*' | head -1 | cut -d':' -f2)
    if [ "$TEST_COUNT" = "0" ]; then
        echo -e "${RED}[PROBLEM]${NC} Report contains 0 tests!"
        echo -e "${YELLOW}[FIX]${NC} This usually means Playwright config is missing outputFile"
        echo ""
        echo -e "  Add to your playwright.config.js:"
        echo -e "  ${GREEN}reporter: [['json', { outputFile: 'test-results.json' }]]${NC}"
        echo ""
    else
        echo -e "${GREEN}[OK]${NC} Report contains $TEST_COUNT tests"
    fi
    
    # Show report age
    if command -v jq &> /dev/null; then
        TIMESTAMP=$(cat "$REPORT_PATH" | jq -r '.metadata.timestamp // empty')
        if [ -n "$TIMESTAMP" ]; then
            echo -e "${BLUE}[INFO]${NC} Report timestamp: $TIMESTAMP"
        fi
    fi
else
    echo -e "${RED}[PROBLEM]${NC} No report.json found in dashboard!"
fi

echo ""

# Copy latest report if available
if [ -n "$LATEST_REPORT" ] && [ -f "$LATEST_REPORT" ]; then
    echo -e "${BLUE}[STEP 2]${NC} Copying latest report to dashboard..."
    
    LATEST_TEST_COUNT=$(cat "$LATEST_REPORT" | grep -o '"total":[0-9]*' | head -1 | cut -d':' -f2)
    echo -e "${BLUE}[INFO]${NC} Latest report has $LATEST_TEST_COUNT tests"
    
    if [ "$LATEST_TEST_COUNT" != "0" ]; then
        cp "$LATEST_REPORT" "$REPORT_PATH"
        echo -e "${GREEN}[OK]${NC} Copied latest report to dashboard"
        
        # Update metadata
        TIMESTAMP=$(date +%s)000
        cat > "$METADATA_PATH" << EOF
{
  "sourceReport": "$LATEST_REPORT",
  "copiedAt": "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")",
  "timestamp": $TIMESTAMP,
  "projectName": "$(cat "$LATEST_REPORT" | grep -o '"projectName":"[^"]*' | cut -d'"' -f4)",
  "testCount": $LATEST_TEST_COUNT
}
EOF
        echo -e "${GREEN}[OK]${NC} Updated report metadata"
    else
        echo -e "${YELLOW}[WARN]${NC} Latest report also has 0 tests - not copying"
    fi
else
    echo -e "${YELLOW}[WARN]${NC} No latest.json found to copy"
    echo -e "${BLUE}[TIP]${NC} Run TestBot first to generate a report"
fi

# Generate embedded report for file:// protocol (bypasses CORS)
echo ""
echo -e "${BLUE}[STEP 2b]${NC} Generating embedded report (fixes CORS issues)..."

EMBEDDED_PATH="$DASHBOARD_DIR/embedded-report.js"
TIMESTAMP=$(date +%s)000

if [ -f "$REPORT_PATH" ]; then
    # Create embedded JavaScript file
    cat > "$EMBEDDED_PATH" << EMBEDEOF
// Auto-generated embedded report data - DO NOT EDIT
// Generated at: $(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
// This file bypasses CORS restrictions when opening dashboard via file:// protocol
window.__TESTBOT_EMBEDDED_REPORT__ = $(cat "$REPORT_PATH");
window.__TESTBOT_REPORT_TIMESTAMP__ = $TIMESTAMP;
console.log('📊 Embedded report data loaded:', {
  project: window.__TESTBOT_EMBEDDED_REPORT__?.metadata?.projectName || 'Unknown',
  tests: window.__TESTBOT_EMBEDDED_REPORT__?.stats?.total || 0,
  timestamp: new Date($TIMESTAMP).toISOString()
});
EMBEDEOF
    echo -e "${GREEN}[OK]${NC} Created embedded-report.js (fixes CORS for file:// protocol)"
else
    echo -e "${YELLOW}[WARN]${NC} No report.json to embed"
fi

echo ""

# Open dashboard with aggressive cache busting
echo -e "${BLUE}[STEP 3]${NC} Opening dashboard with cache-busting..."

TIMESTAMP=$(date +%s)000
RANDOM_PARAM=$RANDOM
DASHBOARD_URL="file://$DASHBOARD_DIR/index.html?t=$TIMESTAMP&r=$RANDOM_PARAM&nocache=true"

echo -e "${BLUE}[INFO]${NC} URL: $DASHBOARD_URL"

# Try to open in browser
if command -v open &> /dev/null; then
    # macOS
    open "$DASHBOARD_URL"
    echo -e "${GREEN}[OK]${NC} Opened in browser (macOS)"
elif command -v xdg-open &> /dev/null; then
    # Linux
    xdg-open "$DASHBOARD_URL"
    echo -e "${GREEN}[OK]${NC} Opened in browser (Linux)"
elif command -v start &> /dev/null; then
    # Windows (Git Bash)
    start "$DASHBOARD_URL"
    echo -e "${GREEN}[OK]${NC} Opened in browser (Windows)"
else
    echo -e "${YELLOW}[WARN]${NC} Could not auto-open browser"
    echo -e "${BLUE}[TIP]${NC} Open this URL manually: $DASHBOARD_URL"
fi

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}  Fix Complete!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${YELLOW}If you still see old data:${NC}"
echo "  1. Press Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows)"
echo "  2. Or open in an Incognito/Private window"
echo "  3. Or clear browser cache completely"
echo ""
echo -e "${BLUE}For detailed diagnostics, run:${NC}"
echo "  node scripts/debug-dashboard.js"
echo ""
