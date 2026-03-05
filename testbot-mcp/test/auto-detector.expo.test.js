const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const AutoDetector = require('../src/auto-detector');

test('AutoDetector prefers Expo web defaults for Playwright-compatible startup', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testbot-auto-detector-expo-'));

  try {
    const packageJson = {
      name: 'expo-demo',
      scripts: {
        start: 'expo start',
        web: 'expo start --web',
      },
      dependencies: {
        expo: '^54.0.0',
        'expo-router': '^6.0.0',
      },
    };

    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      `${JSON.stringify(packageJson, null, 2)}\n`,
      'utf8'
    );

    const detector = new AutoDetector();
    const detected = await detector.detect(tempDir);

    assert.equal(detected.port, 8081);
    assert.equal(detected.baseURL, 'http://localhost:8081');
    assert.match(detected.startCommand, /^npm run web\b/i);
    assert.match(detected.startCommand, /--port 8081/i);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
