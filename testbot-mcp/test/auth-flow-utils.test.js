const assert = require('node:assert/strict');
const test = require('node:test');

const {
  chooseBetterAuthFlow,
  isUnsafeAuthFlow,
  sanitizeAuthFlow,
  scoreAuthFlowCandidate,
} = require('../src/auth-flow-utils');
const {
  _buildAuthFlowCandidate,
  _mergeWalks,
  _routeKeyFromUrl,
} = require('../src/playwright-explorer');
const {
  artifactHasUsefulContext,
  normalizeExplorationArtifact,
} = require('../src/exploration-phase');

test('auth flow scoring rejects register/signup forms as login flows', () => {
  const score = scoreAuthFlowCandidate({
    loginUrl: '/register',
    submitLabels: ['Create account'],
    headings: ['Register'],
    fields: ['email email', 'password password'],
    hasPasswordField: true,
  });

  assert.equal(score.intent, 'register');
  assert.equal(isUnsafeAuthFlow({ loginUrl: '/register', intent: score.intent }), true);
  assert.equal(sanitizeAuthFlow({ loginUrl: '/register', intent: score.intent }), null);
  assert.equal(sanitizeAuthFlow({
    loginUrl: '/auth',
    credentialFields: { username: 'input[name="email"]', password: 'input[type="password"]' },
    failureIndicator: 'email_in_use',
  }), null);
});

test('heuristic explorer prefers login over register when both password forms exist', () => {
  const register = _buildAuthFlowCandidate({
    resolvedPathname: '/register',
    signals: {
      authElements: {
        usernameSelector: 'input[name="email"]',
        passwordSelector: 'input[type="password"]',
      },
      forms: [{ submitLabel: 'Create account', fields: [{ name: 'email', type: 'email' }, { name: 'password', type: 'password' }] }],
      headings: ['Register'],
      buttonTexts: ['Create account'],
      title: 'Register',
    },
  });
  const login = _buildAuthFlowCandidate({
    resolvedPathname: '/login',
    signals: {
      authElements: {
        usernameSelector: 'input[name="email"]',
        passwordSelector: 'input[type="password"]',
      },
      forms: [{ submitLabel: 'Sign in', fields: [{ name: 'email', type: 'email' }, { name: 'password', type: 'password' }] }],
      headings: ['Sign in'],
      buttonTexts: ['Sign in'],
      title: 'Login',
    },
  });

  assert.equal(register.intent, 'register');
  assert.equal(login.intent, 'login');
  assert.equal(chooseBetterAuthFlow(register, login).loginUrl, '/login');
  assert.equal(_mergeWalks([{ routes: [], forms: [], authFlow: register }, { routes: [], forms: [], authFlow: login }]).authFlow.loginUrl, '/login');
});

test('exploration artifact normalizer drops unsafe browser-use authFlow', () => {
  const artifact = normalizeExplorationArtifact({
    routes: [{ path: '/register', requiresAuth: false }],
    authFlow: {
      loginUrl: '/register',
      credentialFields: { username: 'input[name="email"]', password: 'input[type="password"]' },
      successIndicator: '',
      failureIndicator: '[role="alert"]',
    },
    observedErrors: [],
  }, 'browser-use');

  assert.equal(artifact.authFlow, null);
  assert.equal(artifact.authFlowRejected.reason, 'registration_or_signup_flow');
  assert.match(artifact.observedErrors.join('\n'), /Rejected non-login authFlow/);
});

test('exploration useful-context gate rejects empty browser-use artifacts', () => {
  assert.equal(artifactHasUsefulContext({ routes: [], forms: [], keyFlows: [], authFlow: null }), false);
  assert.equal(artifactHasUsefulContext({ routes: [{ path: '/', requiresAuth: false }] }), false);
  assert.equal(artifactHasUsefulContext({ routes: [{ path: '/login', requiresAuth: false }], authFlow: { loginUrl: '/login' } }), false);
  assert.equal(artifactHasUsefulContext({ authFlow: { loginUrl: '/login' } }), false);
  assert.equal(artifactHasUsefulContext({ routes: [{ path: '/products', requiresAuth: false }] }), true);
  assert.equal(artifactHasUsefulContext({ forms: [{ route: '/', fields: [] }] }), true);
  assert.equal(artifactHasUsefulContext({ keyFlows: [{ name: 'checkout', steps: [] }] }), true);
});

test('playwright route keys preserve SPA hash and query state', () => {
  assert.equal(_routeKeyFromUrl('http://localhost:8080/admin#/products', 'http://localhost:8080'), '/admin#/products');
  assert.equal(_routeKeyFromUrl('/products?q=book', 'http://localhost:8080'), '/products?q=book');
  assert.equal(_routeKeyFromUrl('/admin#/orders?status=open', 'http://localhost:8080'), '/admin#/orders?status=open');
});
