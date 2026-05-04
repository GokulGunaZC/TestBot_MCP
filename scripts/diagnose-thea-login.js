'use strict';
/**
 * Standalone login diagnostic for Thea.
 * Run: node scripts/diagnose-thea-login.js
 *
 * Tests both admin and user credentials against http://localhost:3001
 * and reports exactly what the credential injector would see.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE_URL = 'http://localhost:3001';
const LOGIN_URL = `${BASE_URL}/login`;

const CREDS = [
  { role: 'admin',  username: 'shreyespd12@gmail.com',         password: 'spd1234' },
  { role: 'user',   username: 'shreyesprabhudessai@gmail.com', password: 'Spd1234!@#$' },
];

// Selectors — matches what credentials-injector.js uses (plus #email fallback from memory)
const USER_SELECTORS = [
  '#email',
  'input[type="email"]',
  'input[name="email"]',
  'input[name="username"]',
];
const PASS_SELECTOR = 'input[type="password"], input[name="password"]';

async function findInput(page, selectors) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      const visible = await loc.isVisible({ timeout: 2_000 }).catch(() => false);
      if (visible) return { sel, loc };
    } catch { /* try next */ }
  }
  return null;
}

async function diagnoseLogin(cred) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`ROLE: ${cred.role}  |  ${cred.username}`);
  console.log(`${'─'.repeat(60)}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

  try {
    // 1. Navigate to login page
    console.log(`[1] Navigating to ${LOGIN_URL} …`);
    const resp = await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: 30_000 });
    console.log(`    HTTP status: ${resp?.status()}`);
    console.log(`    Final URL:   ${page.url()}`);

    // 2. Locate email field
    console.log(`[2] Looking for email/username input …`);
    const emailField = await findInput(page, USER_SELECTORS);
    if (!emailField) {
      const html = await page.content();
      console.log(`    ✗ No email input found. Page HTML snippet:\n${html.slice(0, 800)}`);
      return { role: cred.role, ok: false, reason: 'email input not found' };
    }
    console.log(`    ✓ Found via selector: ${emailField.sel}`);

    // Count how many matches getByLabel(/email/i) returns (the known bug)
    const labelMatches = await page.getByLabel(/email/i).count().catch(() => -1);
    console.log(`    getByLabel(/email/i) count: ${labelMatches} ${labelMatches > 1 ? '← strict mode violation!' : ''}`);

    // 3. Locate password field
    console.log(`[3] Looking for password input …`);
    const passLoc = page.locator(PASS_SELECTOR).first();
    const passVisible = await passLoc.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!passVisible) {
      console.log(`    ✗ Password field not visible`);
      return { role: cred.role, ok: false, reason: 'password input not found' };
    }
    console.log(`    ✓ Found`);

    // 4. Fill credentials
    console.log(`[4] Filling credentials …`);
    await emailField.loc.fill(cred.username, { timeout: 10_000 });
    await passLoc.fill(cred.password, { timeout: 10_000 });

    // Verify values were actually set
    const filledEmail = await emailField.loc.inputValue();
    const filledPass  = await passLoc.inputValue();
    console.log(`    email filled:    ${filledEmail === cred.username ? '✓' : `✗ got "${filledEmail}"`}`);
    console.log(`    password filled: ${filledPass === cred.password ? '✓' : `✗ got "${filledPass}"`}`);

    // 5. Find submit button
    console.log(`[5] Looking for submit button …`);
    const submitLoc = page.locator('button[type="submit"], input[type="submit"]').first();
    const submitVisible = await submitLoc.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!submitVisible) {
      console.log(`    ✗ Submit button not visible`);
      return { role: cred.role, ok: false, reason: 'submit button not found' };
    }
    const submitText = await submitLoc.textContent().catch(() => '');
    console.log(`    ✓ Found: "${submitText.trim()}"`);

    // 6. Click submit + wait for redirect
    console.log(`[6] Submitting …`);
    const loginPathname = new URL(LOGIN_URL).pathname;
    const [redirected] = await Promise.all([
      page.waitForURL(
        (url) => url.pathname !== loginPathname,
        { timeout: 20_000 }
      ).then(() => true).catch(() => false),
      submitLoc.click({ timeout: 10_000 }),
    ]);

    await page.waitForLoadState('domcontentloaded', { timeout: 8_000 }).catch(() => null);

    const finalUrl = page.url();
    const finalPathname = new URL(finalUrl).pathname;
    console.log(`    Redirected away from login: ${redirected ? '✓' : '✗'}`);
    console.log(`    Final URL: ${finalUrl}`);

    // 7. Check for error messages on page
    const errorSelectors = [
      '[role="alert"]',
      '.error',
      '[class*="error"]',
      '[class*="alert"]',
      'p[style*="red"]',
    ];
    for (const sel of errorSelectors) {
      const errText = await page.locator(sel).first().textContent({ timeout: 1_000 }).catch(() => null);
      if (errText?.trim()) {
        console.log(`    Page error element (${sel}): "${errText.trim()}"`);
      }
    }

    // 8. Console errors captured
    if (errors.length > 0) {
      console.log(`    Console errors during login:`);
      errors.forEach(e => console.log(`      • ${e}`));
    }

    // 9. Save storageState if login succeeded
    const loginVerified = finalPathname !== loginPathname;
    if (loginVerified) {
      const stateDir = path.join('C:/Users/ShreyesPrabhuDesai/PersProjects/thea/.healix');
      fs.mkdirSync(stateDir, { recursive: true });
      const statePath = path.join(stateDir, `diag-auth-state-${cred.role}.json`);
      await context.storageState({ path: statePath });
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      const cookies = state.cookies || [];
      const supabaseCookies = cookies.filter(c => c.name.includes('supabase') || c.name.includes('sb-'));
      console.log(`\n    ✓ LOGIN VERIFIED`);
      console.log(`    storageState saved: ${statePath}`);
      console.log(`    Total cookies: ${cookies.length}`);
      console.log(`    Supabase cookies: ${supabaseCookies.length}`);
      supabaseCookies.forEach(c => console.log(`      • ${c.name} (${c.domain})`));
    } else {
      console.log(`\n    ✗ LOGIN FAILED — stayed on login page`);
    }

    return { role: cred.role, ok: loginVerified };
  } catch (err) {
    console.log(`    ERROR: ${err.message}`);
    return { role: cred.role, ok: false, reason: err.message };
  } finally {
    await browser.close().catch(() => null);
  }
}

async function waitForServer(url, maxMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const { default: http } = await import('http');
      await new Promise((res, rej) => {
        const req = http.get(url, (r) => { r.resume(); res(r.statusCode); });
        req.on('error', rej);
        req.setTimeout(2000, () => rej(new Error('timeout')));
      });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return false;
}

(async () => {
  console.log('Healix — Thea Login Diagnostic');
  console.log(`Target: ${BASE_URL}`);

  process.stdout.write('\nWaiting for Thea dev server');
  const up = await waitForServer(BASE_URL);
  if (!up) {
    console.log('\n✗ Server never came up at', BASE_URL);
    process.exit(1);
  }
  console.log(' ✓\n');

  const results = [];
  for (const cred of CREDS) {
    results.push(await diagnoseLogin(cred));
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('SUMMARY');
  console.log(`${'═'.repeat(60)}`);
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗';
    console.log(`  ${icon} ${r.role.padEnd(8)} — ${r.ok ? 'login verified, storageState saved' : `FAILED: ${r.reason || 'unknown'}`}`);
  }

  const allOk = results.every(r => r.ok);
  process.exit(allOk ? 0 : 1);
})();
