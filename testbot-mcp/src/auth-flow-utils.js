'use strict';

const LOGIN_WORD_RE = /\b(log\s*in|login|sign\s*in|signin|continue|enter|access\s+account|existing\s+account)\b/i;
const REGISTER_WORD_RE = /\b(register|sign\s*up|signup|create\s+account|new\s+account|join\s+now|email[\s_-]*in[\s_-]*use|already\s+registered)\b/i;
const LOGIN_PATH_RE = /(^|[\/#?&._-])(log-?in|signin|sign-?in|session|sessions)([\/#?&._-]|$)/i;
const REGISTER_PATH_RE = /(^|[\/#?&._-])(register|signup|sign-?up|create-?account|join|onboarding)([\/#?&._-]|$)/i;

function compactText(values = []) {
  return values
    .flat()
    .filter(Boolean)
    .map((value) => String(value))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function authFlowPath(value) {
  if (!value) return '';
  try {
    const parsed = new URL(value, 'http://healix.local');
    return `${parsed.pathname || '/'}${parsed.hash || ''}${parsed.search || ''}`;
  } catch {
    return String(value || '');
  }
}

function isLikelyRegistrationUrl(value) {
  return REGISTER_PATH_RE.test(authFlowPath(value));
}

function isLikelyLoginUrl(value) {
  return LOGIN_PATH_RE.test(authFlowPath(value));
}

function scoreAuthFlowCandidate(candidate = {}) {
  const loginUrl = candidate.loginUrl || candidate.path || '';
  const pathText = authFlowPath(loginUrl);
  const labelsText = compactText([
    candidate.submitLabels,
    candidate.buttonTexts,
    candidate.headings,
    candidate.title,
    candidate.text,
    candidate.successIndicator,
    candidate.failureIndicator,
  ]);
  const fieldText = compactText(candidate.fields);

  let score = 0;
  const reasons = [];

  if (isLikelyLoginUrl(pathText)) {
    score += 80;
    reasons.push('login_path');
  }
  if (isLikelyRegistrationUrl(pathText)) {
    score -= 130;
    reasons.push('registration_path');
  }
  if (LOGIN_WORD_RE.test(labelsText)) {
    score += 45;
    reasons.push('login_text');
  }
  if (REGISTER_WORD_RE.test(labelsText)) {
    score -= 100;
    reasons.push('registration_text');
  }
  if (/password/i.test(fieldText) || candidate.hasPasswordField || candidate.credentialFields?.password) {
    score += 25;
    reasons.push('password_field');
  }
  if (/(email|username|user_name|login)/i.test(fieldText) || candidate.credentialFields?.username) {
    score += 15;
    reasons.push('identity_field');
  }
  if (pathText === '/' && LOGIN_WORD_RE.test(labelsText)) {
    score += 15;
    reasons.push('root_login_form');
  }

  const hasRegistrationSignal = reasons.some((reason) => reason.startsWith('registration'));
  const hasLoginSignal = reasons.some((reason) => reason.startsWith('login')) || reasons.includes('root_login_form');
  const intent = hasRegistrationSignal && !hasLoginSignal
    ? 'register'
    : score >= 35
      ? 'login'
      : 'unknown';
  const confidence = score >= 90
    ? 'high'
    : score >= 55
      ? 'medium'
      : score >= 35
        ? 'low'
        : 'none';

  return { score, intent, confidence, reasons };
}

function normalizeAuthFlow(authFlow = null, extraSignals = {}) {
  if (!authFlow || typeof authFlow !== 'object' || !authFlow.loginUrl) return null;
  const scored = scoreAuthFlowCandidate({
    ...extraSignals,
    ...authFlow,
    credentialFields: authFlow.credentialFields,
  });
  return {
    ...authFlow,
    intent: authFlow.intent || scored.intent,
    confidence: authFlow.confidence || scored.confidence,
    score: typeof authFlow.score === 'number' ? authFlow.score : scored.score,
    scoreReasons: Array.isArray(authFlow.scoreReasons) ? authFlow.scoreReasons : scored.reasons,
  };
}

function isUnsafeAuthFlow(authFlow = null) {
  const normalized = normalizeAuthFlow(authFlow);
  if (!normalized) return false;
  if (normalized.intent === 'register') return true;
  if (isLikelyRegistrationUrl(normalized.loginUrl)) return true;
  return false;
}

function isUsableLoginAuthFlow(authFlow = null) {
  const normalized = normalizeAuthFlow(authFlow);
  if (!normalized) return false;
  if (isUnsafeAuthFlow(normalized)) return false;
  return normalized.intent === 'login' || normalized.score >= 35 || isLikelyLoginUrl(normalized.loginUrl);
}

function sanitizeAuthFlow(authFlow = null, extraSignals = {}) {
  const normalized = normalizeAuthFlow(authFlow, extraSignals);
  if (!normalized) return null;
  if (!isUsableLoginAuthFlow(normalized)) return null;
  return {
    loginUrl: normalized.loginUrl,
    credentialFields: normalized.credentialFields || {},
    successIndicator: normalized.successIndicator || '',
    failureIndicator: normalized.failureIndicator || '[role="alert"], .error, .alert-danger',
    intent: 'login',
    confidence: normalized.confidence,
    score: normalized.score,
    scoreReasons: normalized.scoreReasons,
  };
}

function chooseBetterAuthFlow(current = null, candidate = null) {
  const cleanCandidate = sanitizeAuthFlow(candidate);
  if (!cleanCandidate) return sanitizeAuthFlow(current);
  const cleanCurrent = sanitizeAuthFlow(current);
  if (!cleanCurrent) return cleanCandidate;
  return cleanCandidate.score > cleanCurrent.score ? cleanCandidate : cleanCurrent;
}

module.exports = {
  authFlowPath,
  chooseBetterAuthFlow,
  compactText,
  isLikelyLoginUrl,
  isLikelyRegistrationUrl,
  isUnsafeAuthFlow,
  isUsableLoginAuthFlow,
  normalizeAuthFlow,
  sanitizeAuthFlow,
  scoreAuthFlowCandidate,
};
