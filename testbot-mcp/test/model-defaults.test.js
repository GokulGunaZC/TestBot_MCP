const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..', '..');

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf-8');
}

test('webapp and browser-use runtime defaults use gpt-5.5-mini', () => {
  const modelDefaults = read('webapp/src/lib/model-defaults.ts');
  const browserDriver = read('testbot-mcp/src/browser-use-driver.js');
  const browserRunner = read('testbot-mcp/scripts/browser_use_runner.py');
  const pricing = read('webapp/src/lib/pricing.ts');
  const llmProxy = read('webapp/src/app/api/llm-proxy/chat/completions/route.ts');

  assert.match(modelDefaults, /DEFAULT_OPENAI_MODEL\s*=\s*'gpt-5\.5-mini'/);
  assert.match(modelDefaults, /'gpt-5\.5-mini':\s*'gpt-5-mini'/);
  assert.match(modelDefaults, /resolveProviderOpenAIModel/);
  assert.match(browserDriver, /HEALIX_BROWSER_USE_MODEL:\s*process\.env\.HEALIX_BROWSER_USE_MODEL\s*\|\|\s*'gpt-5\.5-mini'/);
  assert.match(browserRunner, /HEALIX_BROWSER_USE_MODEL",\s*"gpt-5\.5-mini"/);
  assert.match(pricing, /'gpt-5\.5-mini':\s*\{/);
  assert.match(pricing, /'gpt-5\.5-mini':\s*\{[\s\S]*outputUsdPerToken:\s*2\.00\s*\/\s*PER_MILLION/);
  assert.match(llmProxy, /resolveProviderOpenAIModel\(parsed\.model\)/);
});

test('old OpenAI model defaults are not used by runtime configuration', () => {
  const runtimeFiles = [
    '.env.example',
    'README.md',
    'webapp/.env.example',
    'webapp/.env.docker.example',
    'webapp/README.md',
    'webapp/src/app/api/analyze-failures/route.ts',
    'webapp/src/app/api/generate-tests/route.ts',
    'webapp/src/app/api/parse-prd/route.ts',
    'webapp/src/lib/test-generation/openai-client.ts',
    'webapp/src/lib/test-generation/openai-generator.ts',
    'webapp/src/lib/test-generation/planner-agent.ts',
  ];
  const forbidden = [
    /process\.env\.OPENAI_MODEL\s*\|\|\s*['"`]gpt-4\.1-mini['"`]/,
    /OPENAI_MODEL=gpt-4o\b/,
    /OPENAI_MODEL=gpt-5\.4-mini\b/,
    /default:\s*`gpt-4o`/,
    /defaults to gpt-4o/i,
  ];

  const failures = [];
  for (const relPath of runtimeFiles) {
    const content = read(relPath);
    for (const pattern of forbidden) {
      if (pattern.test(content)) failures.push(`${relPath}:${pattern}`);
    }
  }

  assert.deepEqual(failures, []);
});
