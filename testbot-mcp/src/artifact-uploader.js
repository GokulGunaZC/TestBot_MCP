/**
 * Artifact Uploader
 * Uploads test artifacts (screenshots, videos, traces) to backend storage
 */

const fs = require('fs');
const path = require('path');
const Logger = require('./logger');

class ArtifactUploader {
  constructor(config = {}) {
    this.config = {
      projectPath: config.projectPath || process.cwd(),
      dashboardUrl: config.dashboardUrl || process.env.TESTBOT_DASHBOARD_URL || 'http://localhost:3000',
      apiKey: config.apiKey || process.env.TESTBOT_API_KEY,
      ...config,
    };
  }

  /**
   * Collect artifacts from test results (already parsed by playwright-integration)
   * Only collects artifacts for failed tests
   */
  collectFailureArtifacts(testResults) {
    const artifacts = [];
    
    // Get failed tests with their artifacts
    const failedTests = (testResults.tests || [])
      .filter(t => t.status === 'failed');
    
    if (failedTests.length === 0) {
      Logger.debug('ArtifactUploader', 'No failed tests, skipping artifact collection');
      return artifacts;
    }

    Logger.info('ArtifactUploader', `Collecting artifacts for ${failedTests.length} failed tests`);

    // Extract artifacts from test results (already parsed by playwright-integration)
    for (const test of failedTests) {
      const testName = test.title || test.name || 'unknown-test';
      const testArtifacts = test.artifacts || {};
      
      Logger.debug('ArtifactUploader', `Test "${testName}" has artifacts:`, {
        screenshots: testArtifacts.screenshots?.length || 0,
        videos: testArtifacts.videos?.length || 0,
        traces: testArtifacts.traces?.length || 0,
      });
      
      // Process screenshots
      for (const screenshot of testArtifacts.screenshots || []) {
        Logger.debug('ArtifactUploader', `Checking screenshot: ${screenshot.path}`);
        if (screenshot.path && fs.existsSync(screenshot.path)) {
          artifacts.push({
            fullPath: screenshot.path,
            fileName: path.basename(screenshot.path),
            type: 'screenshot',
            contentType: screenshot.contentType || 'image/png',
            testName,
          });
        } else {
          Logger.warn('ArtifactUploader', `Screenshot not found: ${screenshot.path}`);
        }
      }
      
      // Process videos
      for (const video of testArtifacts.videos || []) {
        Logger.debug('ArtifactUploader', `Checking video: ${video.path}`);
        if (video.path && fs.existsSync(video.path)) {
          artifacts.push({
            fullPath: video.path,
            fileName: path.basename(video.path),
            type: 'video',
            contentType: video.contentType || 'video/webm',
            testName,
          });
        } else {
          Logger.warn('ArtifactUploader', `Video not found: ${video.path}`);
        }
      }
      
      // Process traces
      for (const trace of testArtifacts.traces || []) {
        Logger.debug('ArtifactUploader', `Checking trace: ${trace.path}`);
        if (trace.path && fs.existsSync(trace.path)) {
          artifacts.push({
            fullPath: trace.path,
            fileName: path.basename(trace.path),
            type: 'trace',
            contentType: trace.contentType || 'application/zip',
            testName,
          });
        } else {
          Logger.warn('ArtifactUploader', `Trace not found: ${trace.path}`);
        }
      }
    }

    Logger.info('ArtifactUploader', `Collected ${artifacts.length} artifacts from ${failedTests.length} failed tests`);
    
    // Fallback: If no artifacts found via test.artifacts, scan filesystem
    if (artifacts.length === 0 && failedTests.length > 0) {
      Logger.warn('ArtifactUploader', 'No artifacts found via test.artifacts, falling back to filesystem scan');
      return this.collectFromFilesystem(failedTests);
    }
    
    return artifacts;
  }
  
  /**
   * Fallback: Scan filesystem for artifacts when test.artifacts is empty
   */
  collectFromFilesystem(failedTests) {
    const artifacts = [];
    const testResultsDir = path.join(this.config.projectPath, 'test-results');
    
    if (!fs.existsSync(testResultsDir)) {
      Logger.debug('ArtifactUploader', 'test-results directory not found');
      return artifacts;
    }
    
    Logger.info('ArtifactUploader', `Scanning ${testResultsDir} for artifacts`);
    
    // Get all test names for matching
    const testNames = failedTests.map(t => (t.title || t.name || '').toLowerCase());
    
    const scanDir = (dir) => {
      if (!fs.existsSync(dir)) return;
      
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          let type = null;
          let contentType = null;
          
          if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
            type = 'screenshot';
            contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
          } else if (ext === '.webm' || ext === '.mp4') {
            type = 'video';
            contentType = ext === '.webm' ? 'video/webm' : 'video/mp4';
          } else if (ext === '.zip' && entry.name.includes('trace')) {
            type = 'trace';
            contentType = 'application/zip';
          }
          
          if (type) {
            // Try to match to a failed test
            const pathLower = fullPath.toLowerCase();
            const matchedTest = failedTests.find(t => {
              const testTitle = (t.title || t.name || '').toLowerCase();
              const normalized = testTitle.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
              return pathLower.includes(normalized) || pathLower.includes(testTitle.replace(/\s+/g, '-'));
            });
            
            if (matchedTest) {
              artifacts.push({
                fullPath,
                fileName: entry.name,
                type,
                contentType,
                testName: matchedTest.title || matchedTest.name || 'unknown-test',
              });
            }
          }
        }
      }
    };
    
    scanDir(testResultsDir);
    
    Logger.info('ArtifactUploader', `Filesystem scan found ${artifacts.length} artifacts`);
    return artifacts;
  }


  /**
   * Upload artifacts to backend storage
   */
  async uploadArtifacts(runId, artifacts) {
    if (!this.config.apiKey) {
      Logger.warn('ArtifactUploader', 'No API key configured, skipping artifact upload');
      return { success: false, reason: 'no_api_key' };
    }

    if (artifacts.length === 0) {
      Logger.debug('ArtifactUploader', 'No artifacts to upload');
      return { success: true, uploaded: 0 };
    }

    const fetchFn = global.fetch || require('node-fetch');

    // Prepare artifacts payload (convert files to base64)
    const payload = artifacts.map(artifact => {
      const content = fs.readFileSync(artifact.fullPath);
      return {
        test_name: artifact.testName,
        type: artifact.type,
        file_name: artifact.fileName,
        content: content.toString('base64'),
        content_type: artifact.contentType,
        metadata: {
          file_size: content.length,
          uploaded_at: new Date().toISOString(),
        },
      };
    });

    Logger.info('ArtifactUploader', `Uploading ${payload.length} artifacts to ${this.config.dashboardUrl}`);

    try {
      const response = await fetchFn(`${this.config.dashboardUrl}/api/upload-artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.config.apiKey,
          run_id: runId,
          artifacts: payload,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        Logger.error('ArtifactUploader', `Upload failed (HTTP ${response.status})`, { error: text });
        return { success: false, reason: `http_${response.status}`, error: text };
      }

      const result = await response.json();
      Logger.info('ArtifactUploader', `Successfully uploaded ${result.uploaded} artifacts`);
      return { success: true, uploaded: result.uploaded, artifacts: result.artifacts };
    } catch (error) {
      Logger.error('ArtifactUploader', 'Upload failed', { error: error.message });
      return { success: false, reason: 'network_error', error: error.message };
    }
  }

  /**
   * Main method: collect and upload artifacts for failed tests
   */
  async processAndUpload(runId, testResults) {
    const artifacts = this.collectFailureArtifacts(testResults);
    
    if (artifacts.length === 0) {
      return { success: true, uploaded: 0, reason: 'no_artifacts' };
    }

    return await this.uploadArtifacts(runId, artifacts);
  }
}

module.exports = ArtifactUploader;
