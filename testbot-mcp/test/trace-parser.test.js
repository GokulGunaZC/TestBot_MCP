'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseTrace, resolveTracePath } = require('../src/failure-triage/trace-parser');

test('parseTrace returns graceful empty evidence when trace path is missing', async () => {
  const evidence = await parseTrace('/tmp/does-not-exist-trace.zip');
  assert.equal(evidence.parseError, 'trace_missing');
  assert.deepEqual(evidence.networkAtFailure, []);
  assert.deepEqual(evidence.consoleAtFailure, []);
  assert.equal(evidence.failedAction, null);
});

test('parseTrace returns parseError for a non-zip file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-trace-'));
  const fakeTrace = path.join(dir, 'not-a-zip.zip');
  fs.writeFileSync(fakeTrace, 'this is definitely not a zip file', 'utf-8');
  const evidence = await parseTrace(fakeTrace);
  // yauzl rejects the file; we surface parseError so callers can downgrade.
  assert.ok(evidence.parseError, 'should set parseError');
  assert.equal(evidence.failedAction, null);
});

test('resolveTracePath picks first existing trace path from artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-trace-'));
  const realTrace = path.join(dir, 'trace-1.zip');
  fs.writeFileSync(realTrace, 'x', 'utf-8');

  const picked = resolveTracePath(
    { traces: [{ path: '/tmp/missing.zip' }, { fullPath: realTrace }] },
    dir,
  );
  assert.equal(picked, realTrace);

  assert.equal(resolveTracePath(null, dir), null);
  assert.equal(resolveTracePath({ traces: [] }, dir), null);
});
