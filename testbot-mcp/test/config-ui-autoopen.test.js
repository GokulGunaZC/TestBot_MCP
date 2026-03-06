const { test } = require('node:test');
const assert = require('node:assert');
const ConfigUILauncher = require('../src/config-ui-launcher');

test('shouldAutoOpenBrowser respects constructor autoOpenBrowser=true even when headless=true', () => {
  const launcher = new ConfigUILauncher({ autoOpenBrowser: true, headless: true });
  const result = launcher.shouldAutoOpenBrowser({ headless: true });
  assert.strictEqual(result, true, 'Should auto-open when constructor has autoOpenBrowser=true');
});

test('shouldAutoOpenBrowser returns false when headless=true and autoOpenBrowser not set', () => {
  const launcher = new ConfigUILauncher({ headless: true });
  const result = launcher.shouldAutoOpenBrowser({ headless: true });
  assert.strictEqual(result, false, 'Should not auto-open in headless mode without explicit autoOpenBrowser');
});

test('shouldAutoOpenBrowser returns true when headless=false and autoOpenBrowser=true', () => {
  const launcher = new ConfigUILauncher({ autoOpenBrowser: true, headless: false });
  const result = launcher.shouldAutoOpenBrowser({ headless: false });
  assert.strictEqual(result, true, 'Should auto-open when not headless and autoOpenBrowser=true');
});
