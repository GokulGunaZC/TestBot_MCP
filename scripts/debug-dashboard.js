#!/usr/bin/env node
/**
 * Dashboard Debug Tool
 * Diagnoses dashboard refresh issues and provides actionable fixes
 * 
 * Usage: node scripts/debug-dashboard.js [project-path]
 */

const fs = require('fs');
const path = require('path');

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

const log = {
  info: (msg) => console.log(`${colors.blue}[INFO]${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}[OK]${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}[WARN]${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}[ERROR]${colors.reset} ${msg}`),
  header: (msg) => console.log(`\n${colors.bold}${colors.cyan}=== ${msg} ===${colors.reset}\n`),
};

class DashboardDebugger {
  constructor(projectPath) {
    this.projectPath = projectPath || process.cwd();
    this.qaFinalPath = this.findQAFinalPath();
    this.dashboardPath = path.join(this.qaFinalPath, 'dashboard', 'public');
    this.issues = [];
    this.recommendations = [];
  }

  /**
   * Find the QA_Final root directory
   */
  findQAFinalPath() {
    // Try common locations
    const possiblePaths = [
      path.join(__dirname, '..'),
      path.join(process.cwd(), '..'),
      process.cwd(),
      '/Users/krishsharma/Desktop/QA_Final',
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(path.join(p, 'dashboard', 'public', 'index.html'))) {
        return p;
      }
    }

    return path.join(__dirname, '..');
  }

  /**
   * Run all diagnostic checks
   */
  async diagnose() {
    console.log(`${colors.bold}Dashboard Debug Tool${colors.reset}`);
    console.log(`QA_Final path: ${this.qaFinalPath}`);
    console.log(`Dashboard path: ${this.dashboardPath}`);
    console.log(`Project path: ${this.projectPath}`);
    console.log('');

    this.checkDashboardFiles();
    this.checkProjectReports();
    this.checkReportContent();
    this.checkTimestamps();
    this.checkPlaywrightConfig();
    this.checkTestResultsJson();
    
    this.printSummary();
    this.printRecommendations();

    return {
      issues: this.issues,
      recommendations: this.recommendations,
    };
  }

  /**
   * Check if dashboard files exist
   */
  checkDashboardFiles() {
    log.header('Dashboard Files');

    const reportPath = path.join(this.dashboardPath, 'report.json');
    const metadataPath = path.join(this.dashboardPath, 'report-metadata.json');
    const indexPath = path.join(this.dashboardPath, 'index.html');

    // Check index.html
    if (fs.existsSync(indexPath)) {
      log.success(`index.html exists`);
    } else {
      log.error(`index.html NOT FOUND at ${indexPath}`);
      this.issues.push('Dashboard index.html is missing');
      this.recommendations.push('Reinstall or restore the dashboard files');
    }

    // Check report.json
    if (fs.existsSync(reportPath)) {
      const stats = fs.statSync(reportPath);
      log.success(`report.json exists (${this.formatFileSize(stats.size)})`);
      
      try {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
        if (report.stats && report.stats.total !== undefined) {
          log.info(`  Project: ${report.metadata?.projectName || 'Unknown'}`);
          log.info(`  Tests: ${report.stats.total} total, ${report.stats.passed} passed, ${report.stats.failed} failed`);
          log.info(`  Generated: ${report.metadata?.timestamp || 'Unknown'}`);
          
          if (report.stats.total === 0) {
            log.warn('  Report contains 0 tests - this is likely a problem!');
            this.issues.push('Dashboard report contains 0 tests');
            this.recommendations.push('Check Playwright config: reporter should be [[\'json\', { outputFile: \'test-results.json\' }]]');
          }
        } else {
          log.warn('  Report structure seems invalid');
          this.issues.push('Dashboard report has invalid structure');
        }
      } catch (error) {
        log.error(`  Failed to parse report.json: ${error.message}`);
        this.issues.push('Dashboard report.json is not valid JSON');
      }
    } else {
      log.error(`report.json NOT FOUND at ${reportPath}`);
      this.issues.push('Dashboard report.json is missing');
      this.recommendations.push('Run tests to generate a report');
    }

    // Check report-metadata.json
    if (fs.existsSync(metadataPath)) {
      try {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        log.success(`report-metadata.json exists`);
        log.info(`  Source: ${metadata.sourceReport || 'Unknown'}`);
        log.info(`  Copied at: ${metadata.copiedAt || 'Unknown'}`);
        log.info(`  Test count: ${metadata.testCount || 0}`);
        
        // Check if source report still exists
        if (metadata.sourceReport && !fs.existsSync(metadata.sourceReport)) {
          log.warn(`  Source report no longer exists at: ${metadata.sourceReport}`);
        }
      } catch (error) {
        log.warn(`  Could not parse report-metadata.json: ${error.message}`);
      }
    } else {
      log.info(`report-metadata.json not found (optional)`);
    }
  }

  /**
   * Check project testbot-reports directory
   */
  checkProjectReports() {
    log.header('Project Reports');

    const reportsDir = path.join(this.projectPath, 'testbot-reports');

    if (!fs.existsSync(reportsDir)) {
      log.warn(`No testbot-reports directory found at ${reportsDir}`);
      this.issues.push('No testbot-reports directory in project');
      this.recommendations.push('Run TestBot to generate reports');
      return;
    }

    const files = fs.readdirSync(reportsDir).filter(f => f.endsWith('.json'));
    log.success(`Found ${files.length} report files in testbot-reports/`);

    // Check latest.json
    const latestPath = path.join(reportsDir, 'latest.json');
    if (fs.existsSync(latestPath)) {
      try {
        const latest = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));
        log.info(`  Latest report: ${latest.metadata?.projectName || 'Unknown'}`);
        log.info(`  Tests: ${latest.stats?.total || 0} total`);
        log.info(`  Timestamp: ${latest.metadata?.timestamp || 'Unknown'}`);
        
        if (latest.stats?.total === 0) {
          log.warn('  Latest report contains 0 tests!');
          this.issues.push('Project latest.json contains 0 tests');
        }
      } catch (error) {
        log.error(`  Could not parse latest.json: ${error.message}`);
      }
    } else {
      log.warn('  No latest.json found');
    }

    // List recent reports
    const reportFiles = files
      .filter(f => f.startsWith('report-') && f !== 'latest.json')
      .sort()
      .reverse()
      .slice(0, 5);

    if (reportFiles.length > 0) {
      log.info('  Recent reports:');
      reportFiles.forEach(f => {
        const stats = fs.statSync(path.join(reportsDir, f));
        log.info(`    - ${f} (${this.formatFileSize(stats.size)})`);
      });
    }
  }

  /**
   * Compare report content between dashboard and project
   */
  checkReportContent() {
    log.header('Report Content Comparison');

    const dashboardReport = path.join(this.dashboardPath, 'report.json');
    const projectReport = path.join(this.projectPath, 'testbot-reports', 'latest.json');

    if (!fs.existsSync(dashboardReport) || !fs.existsSync(projectReport)) {
      log.warn('Cannot compare - one or both reports missing');
      return;
    }

    try {
      const dashboard = JSON.parse(fs.readFileSync(dashboardReport, 'utf-8'));
      const project = JSON.parse(fs.readFileSync(projectReport, 'utf-8'));

      const dashboardTimestamp = new Date(dashboard.metadata?.timestamp || 0);
      const projectTimestamp = new Date(project.metadata?.timestamp || 0);

      if (dashboardTimestamp.getTime() === projectTimestamp.getTime()) {
        log.success('Dashboard and project reports match (same timestamp)');
      } else if (projectTimestamp > dashboardTimestamp) {
        log.warn('Project has newer report than dashboard!');
        log.info(`  Dashboard: ${dashboard.metadata?.timestamp}`);
        log.info(`  Project:   ${project.metadata?.timestamp}`);
        this.issues.push('Dashboard is showing older report than project');
        this.recommendations.push('Run: node scripts/fix-dashboard-now.sh to copy latest report');
      } else {
        log.info('Dashboard report is newer or from different project');
        log.info(`  Dashboard: ${dashboard.metadata?.projectName} (${dashboard.metadata?.timestamp})`);
        log.info(`  Project:   ${project.metadata?.projectName} (${project.metadata?.timestamp})`);
      }

      // Compare test counts
      if (dashboard.stats?.total !== project.stats?.total) {
        log.info(`  Test count differs: Dashboard=${dashboard.stats?.total}, Project=${project.stats?.total}`);
      }
    } catch (error) {
      log.error(`Failed to compare reports: ${error.message}`);
    }
  }

  /**
   * Check timestamps for staleness
   */
  checkTimestamps() {
    log.header('Timestamp Analysis');

    const reportPath = path.join(this.dashboardPath, 'report.json');
    
    if (!fs.existsSync(reportPath)) {
      return;
    }

    try {
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      const reportTime = new Date(report.metadata?.timestamp || 0);
      const now = new Date();
      const ageMinutes = Math.floor((now - reportTime) / (1000 * 60));
      const ageHours = Math.floor(ageMinutes / 60);

      log.info(`Report timestamp: ${report.metadata?.timestamp}`);
      
      if (ageMinutes < 5) {
        log.success(`Report is fresh (${ageMinutes} minutes old)`);
      } else if (ageMinutes < 60) {
        log.info(`Report is ${ageMinutes} minutes old`);
      } else if (ageHours < 24) {
        log.warn(`Report is ${ageHours} hours old`);
      } else {
        log.warn(`Report is ${Math.floor(ageHours / 24)} days old!`);
        this.issues.push('Dashboard report is very old');
        this.recommendations.push('Run TestBot to generate a fresh report');
      }

      // Check file modification time vs JSON timestamp
      const fileStats = fs.statSync(reportPath);
      const fileMtime = fileStats.mtime;
      log.info(`File modification time: ${fileMtime.toISOString()}`);

    } catch (error) {
      log.error(`Failed to analyze timestamps: ${error.message}`);
    }
  }

  /**
   * Check Playwright configuration
   */
  checkPlaywrightConfig() {
    log.header('Playwright Configuration');

    const configPath = path.join(this.projectPath, 'playwright.config.js');
    const configTsPath = path.join(this.projectPath, 'playwright.config.ts');

    let configFile = null;
    if (fs.existsSync(configPath)) {
      configFile = configPath;
    } else if (fs.existsSync(configTsPath)) {
      configFile = configTsPath;
    }

    if (!configFile) {
      log.warn('No playwright.config.js or playwright.config.ts found in project');
      this.recommendations.push('Create a Playwright config with JSON reporter');
      return;
    }

    log.success(`Found: ${path.basename(configFile)}`);

    const content = fs.readFileSync(configFile, 'utf-8');

    // Check for JSON reporter configuration
    if (content.includes('reporter') && content.includes('json')) {
      if (content.includes('outputFile')) {
        log.success('JSON reporter configured with outputFile');
      } else if (content.includes("reporter: 'json'") || content.includes('reporter: "json"')) {
        log.error('JSON reporter configured WITHOUT outputFile!');
        log.info('  This means results go to stdout, not a file');
        this.issues.push('Playwright JSON reporter missing outputFile configuration');
        this.recommendations.push("Change reporter config to: reporter: [['json', { outputFile: 'test-results.json' }]]");
      } else {
        log.info('JSON reporter appears to be configured');
      }
    } else {
      log.warn('JSON reporter not found in config');
      this.recommendations.push('Add JSON reporter to playwright.config.js');
    }
  }

  /**
   * Check for test-results.json file
   */
  checkTestResultsJson() {
    log.header('Test Results File');

    const testResultsPath = path.join(this.projectPath, 'test-results.json');

    if (fs.existsSync(testResultsPath)) {
      const stats = fs.statSync(testResultsPath);
      log.success(`test-results.json exists (${this.formatFileSize(stats.size)})`);
      
      try {
        const results = JSON.parse(fs.readFileSync(testResultsPath, 'utf-8'));
        
        // Count tests in Playwright format
        let testCount = 0;
        const countTests = (suites) => {
          for (const suite of suites || []) {
            for (const spec of suite.specs || []) {
              testCount += (spec.tests || []).length;
            }
            if (suite.suites) {
              countTests(suite.suites);
            }
          }
        };
        countTests(results.suites);
        
        log.info(`  Contains ${testCount} tests`);
        
        if (testCount === 0) {
          log.warn('  test-results.json contains 0 tests');
          this.issues.push('test-results.json is empty');
        }
      } catch (error) {
        log.error(`  Failed to parse: ${error.message}`);
        this.issues.push('test-results.json is not valid JSON');
      }
    } else {
      log.warn(`test-results.json NOT FOUND at ${testResultsPath}`);
      log.info('  This file should be created when Playwright runs with JSON reporter');
      this.issues.push('test-results.json not found');
      this.recommendations.push('Ensure Playwright config has: reporter: [[\'json\', { outputFile: \'test-results.json\' }]]');
    }
  }

  /**
   * Print summary of issues found
   */
  printSummary() {
    log.header('Summary');

    if (this.issues.length === 0) {
      log.success('No issues found! Dashboard should be working correctly.');
      log.info('If data still looks stale, try:');
      log.info('  1. Hard refresh: Cmd+Shift+R (Mac) or Ctrl+Shift+R (Windows)');
      log.info('  2. Clear browser cache completely');
      log.info('  3. Open in incognito/private window');
    } else {
      log.error(`Found ${this.issues.length} issue(s):`);
      this.issues.forEach((issue, i) => {
        console.log(`  ${i + 1}. ${issue}`);
      });
    }
  }

  /**
   * Print recommendations
   */
  printRecommendations() {
    if (this.recommendations.length === 0) {
      return;
    }

    log.header('Recommendations');
    this.recommendations.forEach((rec, i) => {
      console.log(`  ${i + 1}. ${rec}`);
    });

    console.log('\n');
    log.info('Quick fix commands:');
    console.log('  # Copy latest report to dashboard:');
    console.log('  node scripts/fix-dashboard-now.js');
    console.log('');
    console.log('  # Hard refresh dashboard:');
    console.log('  ./refresh-dashboard.sh');
  }

  /**
   * Format file size for display
   */
  formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

// Main execution
const projectPath = process.argv[2] || process.cwd();
const debugger_ = new DashboardDebugger(projectPath);
debugger_.diagnose().catch(console.error);
