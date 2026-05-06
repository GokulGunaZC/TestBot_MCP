/**
 * AI Providers Factory
 * Creates the appropriate AI analyzer based on provider name.
 * Only `saas` is supported for failure analysis — all AI calls are proxied
 * through the Healix webapp using HEALIX_API_KEY.
 */

const SaaSClient = require('./saas-client');

class AIAnalyzer {
  static create(provider, apiKey) {
    if (provider && provider.toLowerCase() !== 'saas') {
      console.warn(`[AIAnalyzer] Unknown provider '${provider}' — using SaaS (the only supported provider)`);
    }
    return new SaaSClient({ apiKey });
  }
}

module.exports = AIAnalyzer;
