/**
 * Report Generator
 * Generates test reports in JSON format for the dashboard
 */

const fs = require('fs');
const path = require('path');

class ReportGenerator {
  /**
   * Generate a test report
   */
  async generate({ projectPath, projectName, testResults, aiAnalysis, jiraData }) {
    const timestamp = new Date().toISOString();
    const reportsDir = path.join(projectPath, 'testbot-reports');

    // Validate and normalize test results
    if (!testResults) {
      console.warn('[Report] No test results provided, creating empty report');
      testResults = {
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        duration: 0,
        tests: [],
        failures: []
      };
    }
    
    // Ensure tests array exists
    if (!testResults.tests) {
      testResults.tests = [];
    }

    // Log what we're generating
    console.error(`[Report] Generating report for: ${projectName || path.basename(projectPath)}`);
    console.error(`[Report] Test results: ${testResults.total} total, ${testResults.passed} passed, ${testResults.failed} failed`);
    console.error(`[Report] Tests array length: ${testResults.tests.length}`);

    // Ensure reports directory exists
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    // Build report structure
    const report = {
      metadata: {
        timestamp,
        projectName: projectName || path.basename(projectPath),
        projectPath,
        version: '1.0.0',
        generator: 'testbot-mcp',
      },
      stats: {
        total: testResults.total || 0,
        passed: testResults.passed || 0,
        failed: testResults.failed || 0,
        skipped: testResults.skipped || 0,
        duration: testResults.duration || 0,
        passRate: testResults.total > 0
          ? Math.round((testResults.passed / testResults.total) * 100)
          : 0,
      },
      tests: this.buildTestsList(testResults, aiAnalysis, jiraData),
      aiSummary: aiAnalysis ? this.buildAISummary(aiAnalysis) : null,
      jiraSummary: jiraData ? this.buildJiraSummary(jiraData) : null,
    };

    // Save report
    const reportFilename = `report-${timestamp.replace(/[:.]/g, '-')}.json`;
    const reportPath = path.join(reportsDir, reportFilename);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

    // Also save as latest.json for easy access
    const latestPath = path.join(reportsDir, 'latest.json');
    fs.writeFileSync(latestPath, JSON.stringify(report, null, 2), 'utf-8');

    console.error(`[Report] Saved: ${reportPath}`);
    console.error(`[Report] Latest: ${latestPath}`);

    // Copy artifacts if present
    await this.copyArtifacts(testResults, reportsDir);
    
    // Copy Playwright HTML report if it exists
    await this.copyPlaywrightHTMLReport(projectPath, reportsDir);

    return {
      path: reportPath,
      latestPath,
      url: `file://${reportPath}`,
    };
  }

  /**
   * Build tests list with AI analysis and Jira data merged
   */
  buildTestsList(testResults, aiAnalysis, jiraData) {
    const tests = testResults.tests || [];

    return tests.map((test) => {
      const testObj = {
        id: test.id,
        title: test.title,
        suite: test.suite,
        file: test.file,
        status: this.normalizeStatus(test.status),
        duration: test.duration,
        error: test.error,
        retries: test.retries || 0,
        attachments: {
          screenshots: test.artifacts?.screenshots || [],
          videos: test.artifacts?.videos || [],
          traces: test.artifacts?.traces || [],
          other: [],
        },
      };

      // Merge AI analysis if available
      if (aiAnalysis) {
        const analysis = aiAnalysis.find(
          (a) => a.testName === test.title || a.failure?.testName === test.title
        );
        if (analysis) {
          testObj.aiAnalysis = {
            analysis: analysis.analysis,
            rootCause: analysis.rootCause,
            suggestedFix: analysis.suggestedFix,
            confidence: analysis.confidence,
            affectedFiles: analysis.affectedFiles,
            testingRecommendations: analysis.testingRecommendations,
            aiProvider: 'testbot',
            model: 'sarvam-m',
          };
        }
      }

      // Merge Jira data if available
      if (jiraData) {
        // Try to match by file name pattern (e.g., mscship_1.spec.js -> MSCSHIP-1)
        const jiraMatch = test.file?.match(/([a-z]+)[_-]?(\d+)/i);
        if (jiraMatch) {
          const storyKey = `${jiraMatch[1].toUpperCase()}-${jiraMatch[2]}`;
          const story = jiraData.find((s) => s.key === storyKey);
          if (story) {
            testObj.jiraStory = {
              key: story.key,
              summary: story.summary,
              status: story.status,
              priority: story.priority,
            };
          }
        }
      }

      return testObj;
    });
  }

  /**
   * Build AI analysis summary
   */
  buildAISummary(aiAnalysis) {
    const total = aiAnalysis.length;
    const highConfidence = aiAnalysis.filter((a) => a.confidence >= 0.8).length;
    const mediumConfidence = aiAnalysis.filter((a) => a.confidence >= 0.5 && a.confidence < 0.8).length;
    const lowConfidence = aiAnalysis.filter((a) => a.confidence < 0.5).length;

    return {
      total,
      highConfidence,
      mediumConfidence,
      lowConfidence,
      analyses: aiAnalysis.map((a) => ({
        testName: a.testName || a.failure?.testName,
        file: a.file || a.failure?.file,
        analysis: a.analysis,
        confidence: a.confidence,
      })),
    };
  }

  /**
   * Build Jira summary
   */
  buildJiraSummary(jiraData) {
    return {
      total: jiraData.length,
      stories: jiraData.map((s) => ({
        key: s.key,
        summary: s.summary,
        status: s.status,
        acceptanceCriteria: s.acceptanceCriteria?.length || 0,
      })),
    };
  }

  /**
   * Copy test artifacts to report directory
   * Handles artifacts from both TestBot direct execution and Playwright MCP
   */
  async copyArtifacts(testResults, reportsDir) {
    const artifactsDir = path.join(reportsDir, 'artifacts');
    let artifactsCopied = 0;

    // Helper function to copy artifacts from a collection
    const copyArtifactCollection = (artifacts, type) => {
      if (!artifacts || !Array.isArray(artifacts)) return;
      
      const destDir = path.join(artifactsDir, type);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      
      for (const artifact of artifacts) {
        // Handle both formats: { path: '...' } or { fullPath: '...' }
        const sourcePath = artifact.fullPath || artifact.path;
        if (!sourcePath) continue;
        
        // Try absolute path first, then relative to project
        let actualPath = sourcePath;
        if (!fs.existsSync(actualPath) && !path.isAbsolute(actualPath)) {
          // Try relative to reports directory parent
          const projectPath = path.dirname(reportsDir);
          actualPath = path.join(projectPath, sourcePath);
        }
        
        if (fs.existsSync(actualPath)) {
          const destPath = path.join(destDir, path.basename(actualPath));
          try {
            fs.copyFileSync(actualPath, destPath);
            artifactsCopied++;
            
            // Update artifact path to point to new location
            artifact.path = path.relative(reportsDir, destPath);
          } catch (error) {
            console.error(`[Report] Failed to copy ${type}: ${error.message}`);
          }
        }
      }
    };

    // Copy artifacts from test failures
    const failures = testResults.failures || [];
    for (const failure of failures) {
      const artifacts = failure.artifacts || {};
      copyArtifactCollection(artifacts.screenshots, 'screenshots');
      copyArtifactCollection(artifacts.videos, 'videos');
      copyArtifactCollection(artifacts.traces, 'traces');
      copyArtifactCollection(artifacts.other, 'other');
    }

    // Copy global artifacts (from merged results with MCP)
    if (testResults.artifacts) {
      const globalArtifacts = testResults.artifacts;
      copyArtifactCollection(globalArtifacts.screenshots, 'screenshots');
      copyArtifactCollection(globalArtifacts.videos, 'videos');
      copyArtifactCollection(globalArtifacts.traces, 'traces');
      copyArtifactCollection(globalArtifacts.other, 'other');
    }

    // Also copy artifacts from individual tests
    for (const test of testResults.tests || []) {
      const artifacts = test.artifacts || {};
      copyArtifactCollection(artifacts.screenshots, 'screenshots');
      copyArtifactCollection(artifacts.videos, 'videos');
      copyArtifactCollection(artifacts.traces, 'traces');
      copyArtifactCollection(artifacts.other, 'other');
    }

    // Scan playwright-mcp-output directory if it exists
    const mcpOutputDir = path.join(path.dirname(reportsDir), 'playwright-mcp-output');
    if (fs.existsSync(mcpOutputDir)) {
      console.error(`[Report] Scanning MCP output directory: ${mcpOutputDir}`);
      artifactsCopied += await this.scanAndCopyMCPArtifacts(mcpOutputDir, artifactsDir);
    }

    // Scan test-results directory for any remaining artifacts
    const testResultsDir = path.join(path.dirname(reportsDir), 'test-results');
    if (fs.existsSync(testResultsDir)) {
      console.error(`[Report] Scanning test-results directory: ${testResultsDir}`);
      artifactsCopied += await this.scanAndCopyTestResultsArtifacts(testResultsDir, artifactsDir);
    }

    if (artifactsCopied > 0) {
      console.error(`[Report] Copied ${artifactsCopied} artifacts total`);
    }
  }

  /**
   * Scan and copy artifacts from Playwright MCP output directory
   */
  async scanAndCopyMCPArtifacts(mcpDir, artifactsDir) {
    let copied = 0;
    
    const scanDir = (dir) => {
      if (!fs.existsSync(dir)) return;
      
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            let destType = null;
            
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
              destType = 'screenshots';
            } else if (['.webm', '.mp4', '.mov'].includes(ext)) {
              destType = 'videos';
            } else if (ext === '.zip' || entry.name.includes('trace')) {
              destType = 'traces';
            }
            
            if (destType) {
              const destDir = path.join(artifactsDir, destType);
              if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
              }
              
              const destPath = path.join(destDir, entry.name);
              if (!fs.existsSync(destPath)) {
                try {
                  fs.copyFileSync(fullPath, destPath);
                  copied++;
                } catch (error) {
                  console.error(`[Report] Failed to copy MCP artifact: ${error.message}`);
                }
              }
            }
          }
        }
      } catch (error) {
        console.error(`[Report] Error scanning MCP directory: ${error.message}`);
      }
    };
    
    scanDir(mcpDir);
    return copied;
  }

  /**
   * Scan and copy artifacts from test-results directory
   */
  async scanAndCopyTestResultsArtifacts(testResultsDir, artifactsDir) {
    let copied = 0;
    
    const scanDir = (dir) => {
      if (!fs.existsSync(dir)) return;
      
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            let destType = null;
            
            if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
              destType = 'screenshots';
            } else if (['.webm', '.mp4', '.mov'].includes(ext)) {
              destType = 'videos';
            } else if (ext === '.zip' || entry.name.includes('trace')) {
              destType = 'traces';
            }
            
            if (destType) {
              const destDir = path.join(artifactsDir, destType);
              if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
              }
              
              const destPath = path.join(destDir, entry.name);
              if (!fs.existsSync(destPath)) {
                try {
                  fs.copyFileSync(fullPath, destPath);
                  copied++;
                } catch (error) {
                  console.error(`[Report] Failed to copy test-results artifact: ${error.message}`);
                }
              }
            }
          }
        }
      } catch (error) {
        console.error(`[Report] Error scanning test-results directory: ${error.message}`);
      }
    };
    
    scanDir(testResultsDir);
    return copied;
  }

  /**
   * Copy Playwright HTML report to testbot-reports directory
   */
  async copyPlaywrightHTMLReport(projectPath, reportsDir) {
    try {
      // Check for Playwright HTML report in common locations
      const possibleLocations = [
        path.join(projectPath, 'playwright-report'),
        path.join(projectPath, 'examples', 'sample-project', 'playwright-report'),
        path.join(projectPath, 'sample-project', 'playwright-report'),
      ];
      
      let sourceReportDir = null;
      for (const location of possibleLocations) {
        if (fs.existsSync(location) && fs.existsSync(path.join(location, 'index.html'))) {
          sourceReportDir = location;
          break;
        }
      }
      
      if (!sourceReportDir) {
        console.error('[Report] No Playwright HTML report found to copy');
        return;
      }
      
      const destReportDir = path.join(reportsDir, 'playwright-report');
      
      // Remove old report if it exists
      if (fs.existsSync(destReportDir)) {
        fs.rmSync(destReportDir, { recursive: true, force: true });
      }
      
      // Copy the entire report directory
      this.copyDirectoryRecursive(sourceReportDir, destReportDir);
      
      console.error(`[Report] Copied Playwright HTML report from ${sourceReportDir} to ${destReportDir}`);
    } catch (error) {
      console.error(`[Report] Failed to copy Playwright HTML report: ${error.message}`);
    }
  }
  
  /**
   * Recursively copy a directory
   */
  copyDirectoryRecursive(source, dest) {
    // Create destination directory
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    
    // Read all files/folders in source
    const items = fs.readdirSync(source);
    
    for (const item of items) {
      const sourcePath = path.join(source, item);
      const destPath = path.join(dest, item);
      
      const stat = fs.statSync(sourcePath);
      
      if (stat.isDirectory()) {
        // Recursively copy subdirectory
        this.copyDirectoryRecursive(sourcePath, destPath);
      } else {
        // Copy file
        fs.copyFileSync(sourcePath, destPath);
      }
    }
  }

  /**
   * Normalize test status
   */
  normalizeStatus(status) {
    if (!status) return 'unknown';
    const normalized = status.toLowerCase();
    if (normalized === 'expected') return 'passed';
    if (normalized === 'unexpected') return 'failed';
    if (normalized === 'pending') return 'skipped';
    return normalized;
  }
}

module.exports = ReportGenerator;
