'use strict';

/**
 * Thin wrapper that exposes a failure-analysis surface to
 * `pipeline-worker.js` (via `AIAnalyzer.create('saas')`).
 * All network logic lives in `../webapp-client.js`.
 */

const WebappClient = require('../webapp-client');

class SaaSClient {
  constructor({ apiKey, dashboardUrl } = {}) {
    this._client = new WebappClient({ apiKey, dashboardUrl });
  }

  async analyzeFailures(failures) {
    const payload = await this._client.analyzeFailures(failures);
    return {
      analyses: Array.isArray(payload?.analyses) ? payload.analyses : [],
      tokenUsage: payload?.tokenUsage ?? null,
    };
  }

  async analyzeFailure(failure) {
    const { analyses: results } = await this.analyzeFailures([failure]);
    return results[0] || {
      failure,
      testName: failure.testName,
      file: failure.file,
      analysis: 'Healix returned no analysis for this failure',
      rootCause: 'Unknown',
      suggestedFix: { description: 'Manual review required', changes: [] },
      confidence: 0,
      affectedFiles: [failure.file],
      testingRecommendations: 'Manual investigation needed',
    };
  }
}

module.exports = SaaSClient;
