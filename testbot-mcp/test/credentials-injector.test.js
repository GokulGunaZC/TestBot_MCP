const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildLoginCandidates,
  normalizeRoleLabel,
  stateFileFor,
} = require('../src/credentials-injector');

test('credential injector probes common login routes when authFlow is unknown', () => {
  assert.deepEqual(
    buildLoginCandidates('http://localhost:3001'),
    [
      'http://localhost:3001/',
      'http://localhost:3001/login',
      'http://localhost:3001/signin',
      'http://localhost:3001/sign-in',
      'http://localhost:3001/auth/login',
      'http://localhost:3001/auth/signin',
    ],
  );
});

test('credential injector honors explicit authFlow loginUrl before fallbacks', () => {
  assert.deepEqual(
    buildLoginCandidates('http://localhost:3001', { loginUrl: '/admin/login' }),
    ['http://localhost:3001/admin/login'],
  );
});

test('credential injector normalizes role aliases for storageState names', () => {
  assert.equal(normalizeRoleLabel('Administrator'), 'admin');
  assert.equal(normalizeRoleLabel('super_admin'), 'admin');
  assert.equal(normalizeRoleLabel('Authenticated'), 'user');
  assert.equal(normalizeRoleLabel('QA Admin'), 'qa_admin');
  assert.match(stateFileFor('/tmp/app', 'Administrator'), /auth-state-admin\.json$/);
});
