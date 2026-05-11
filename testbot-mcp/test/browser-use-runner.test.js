const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const runnerPath = path.join(__dirname, '..', 'scripts', 'browser_use_runner.py');

function pythonCmd() {
  for (const cmd of ['python3', 'python']) {
    const res = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
    if (res.status === 0) return cmd;
  }
  return null;
}

function buildTask({ preauthVerified = false, withCredentials = true } = {}) {
  const cmd = pythonCmd();
  if (!cmd) return null;
  const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("browser_use_runner", ${JSON.stringify(runnerPath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
task = mod._build_task(
  "http://localhost:8080",
  "user@example.test" if ${withCredentials ? 'True' : 'False'} else None,
  "Password123!" if ${withCredentials ? 'True' : 'False'} else None,
  preauth_verified=${preauthVerified ? 'True' : 'False'},
)
print(json.dumps(task))
`;
  const res = spawnSync(cmd, ['-c', script], { encoding: 'utf-8' });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('browser-use task skips credential resubmission when pre-auth storageState exists', (t) => {
  const task = buildTask({ preauthVerified: true, withCredentials: true });
  if (!task) {
    t.skip('python not available');
    return;
  }

  assert.match(task, /already verified at least one role/i);
  assert.match(task, /Do NOT submit the login form/i);
  assert.match(task, /Playwright storageState pass/i);
});

test('browser-use task bounds login retries for async auth chrome apps', (t) => {
  const task = buildTask({ preauthVerified: false, withCredentials: true });
  if (!task) {
    t.skip('python not available');
    return;
  }

  assert.match(task, /Submit the login form at most ONE time/i);
  assert.match(task, /do\s+NOT retry login just because the navbar still shows Login\/Sign up/i);
  assert.match(task, /repaint auth chrome asynchronously/i);
});
