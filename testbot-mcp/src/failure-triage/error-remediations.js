'use strict';

/**
 * Error-code → remediation registry.
 *
 * When Healix terminates with a pipeline-level error (webapp unreachable,
 * missing Playwright dep, fixture type mismatch, etc.) the old behavior was to
 * relay a human-readable string back to the Cursor agent and call it done. The
 * agent would then surface the error to the user and stop.
 *
 * With this registry, every classified errorCode carries a structured
 * `remediation` block that the agent can act on directly: a list of shell
 * commands to run, optional readiness probes, and a retry instruction telling
 * it how to resume the Healix workflow once the fix is in place.
 *
 * Rules:
 *   - `fixable: true` means the agent should attempt the remediationSteps
 *     without asking the user first. `fixable: false` means the agent must
 *     surface the problem (legal/compliance/credentials/etc.).
 *   - `remediationSteps` entries are ordered; the agent runs them sequentially.
 *   - `diagnosticCommands` are read-only commands the agent can run first to
 *     confirm the diagnosis before applying a fix.
 *   - `retry` describes how to re-drive Healix after the fix lands. Shape:
 *       { tool: 'healix_test_my_app' | 'healix_check_run_status',
 *         reuseRunId: boolean,  // true → pass the same runId; false → fresh call }
 */

const REMEDIATIONS = {
  WEBAPP_UNREACHABLE: {
    fixable: true,
    headline: 'Healix webapp is not reachable — start it and retry.',
    diagnosticCommands: [
      { shell: 'curl -sS -o /dev/null -w "%{http_code}" http://localhost:3000/api/healthz || true',
        purpose: 'Confirm the webapp is not serving on localhost:3000.' },
    ],
    remediationSteps: [
      { kind: 'shell',
        command: 'cd webapp && npm install',
        description: 'Install webapp deps if the directory has never been booted.',
        optional: true },
      { kind: 'shell',
        command: 'cd webapp && npm run dev',
        description: 'Start the Healix webapp on http://localhost:3000.',
        runInBackground: true },
      { kind: 'wait_for_url',
        url: 'http://localhost:3000/api/healthz',
        timeoutMs: 60_000,
        description: 'Wait until the webapp is ready to serve API requests.' },
    ],
    retry: { tool: 'healix_test_my_app', reuseRunId: false },
    agentInstruction: 'The Healix webapp is not running. Start it in the background (`cd webapp && npm run dev`), wait for http://localhost:3000/api/healthz to respond, then call healix_test_my_app again with the same projectPath. Do not hand this error back to the user — it is auto-fixable.',
  },

  PLAYWRIGHT_DEPENDENCY_MISSING: {
    fixable: true,
    headline: '@playwright/test is missing from the target project — install it and retry.',
    diagnosticCommands: [
      { shell: 'cat package.json | grep -E "\\"@playwright/test\\"" || true',
        purpose: 'Check whether the project declares @playwright/test at all.' },
    ],
    remediationSteps: [
      { kind: 'detect_package_manager',
        description: 'Pick npm | yarn | pnpm from the lockfile in the target project root.' },
      { kind: 'shell',
        command: 'npm install --save-dev @playwright/test',
        alternates: {
          yarn: 'yarn add --dev @playwright/test',
          pnpm: 'pnpm add -D @playwright/test',
        },
        description: 'Install @playwright/test as a devDependency.' },
      { kind: 'shell',
        command: 'npx playwright install chromium',
        description: 'Download the Chromium browser Playwright needs at runtime.',
        optional: true },
    ],
    retry: { tool: 'healix_test_my_app', reuseRunId: false },
    agentInstruction: '@playwright/test is not resolvable from the project root. Install it with the project\'s package manager, then re-run healix_test_my_app. This is auto-fixable without user input.',
  },

  MISSING_DEPENDENCY: {
    fixable: true,
    headline: 'A module required by a generated test is missing.',
    diagnosticCommands: [
      { shell: 'grep -n "Cannot find module" <stderr>',
        purpose: 'Extract the exact missing module name from the captured stderr.' },
    ],
    remediationSteps: [
      { kind: 'extract_module_name',
        from: 'stderr',
        pattern: /Cannot find module ['"]([^'"]+)['"]/i,
        description: 'Pull the missing module name out of the stderr.' },
      { kind: 'shell',
        command: 'npm install --save-dev <MODULE>',
        description: 'Install the missing module (replace <MODULE> with the extracted name).' },
    ],
    retry: { tool: 'healix_test_my_app', reuseRunId: false },
    agentInstruction: 'A generated test imports a module that is not installed. Extract the module name from the stderr, install it as a devDependency, then re-run healix_test_my_app.',
  },

  FIXTURE_MODULE_TYPE_MISMATCH: {
    fixable: true,
    headline: 'Generated fixture module type (CJS/ESM) does not match the project.',
    diagnosticCommands: [
      { shell: 'cat package.json | grep -E "\\"type\\"" || echo "no type field"',
        purpose: 'Confirm the project\'s declared module type.' },
    ],
    remediationSteps: [
      { kind: 'rerun_tool',
        tool: 'healix_test_my_app',
        description: 'Healix regenerates the fixture on every run matching the project\'s package.json "type". Re-running picks up the fix.' },
    ],
    retry: { tool: 'healix_test_my_app', reuseRunId: false },
    agentInstruction: 'The generated __healix-fixture was parsed as ESM but emitted CJS (or vice versa). This was a known Healix bug; the generator now matches the fixture type to package.json. Re-run healix_test_my_app to pick up the fix. No user input needed.',
  },

  SERVER_START_TIMEOUT: {
    fixable: false,
    headline: 'Healix could not reach the project\'s dev server.',
    diagnosticCommands: [
      { shell: 'echo "Check the start command and port configured in the Healix config form."',
        purpose: 'The dev server never became reachable — causes vary by project.' },
    ],
    remediationSteps: [
      { kind: 'surface_to_user',
        description: 'Ask the user to verify: (a) the start command they set in the config form actually starts the dev server, (b) the baseUrl/port matches what the server binds to, (c) the server did not crash on boot.' },
    ],
    retry: { tool: 'healix_test_my_app', reuseRunId: false },
    agentInstruction: 'The target project\'s dev server never became reachable. This is project-specific — surface the stderr to the user and ask them to confirm their start command and baseUrl in the Healix config form before re-running.',
  },

  NO_TESTS_LOADED: {
    fixable: true,
    headline: 'Playwright loaded zero tests — usually an import/syntax error blocked the loader.',
    diagnosticCommands: [
      { shell: 'ls -la tests/generated/ 2>/dev/null || echo "no generated dir"',
        purpose: 'Confirm generated tests exist on disk.' },
    ],
    remediationSteps: [
      { kind: 'scan_stderr_for_syntax_error',
        description: 'Look upward in the stderr for a SyntaxError or import failure — that file blocked the loader.' },
      { kind: 'rerun_tool',
        tool: 'healix_test_my_app',
        description: 'Re-run Healix once the blocking file is fixed or removed.' },
    ],
    retry: { tool: 'healix_test_my_app', reuseRunId: false },
    agentInstruction: 'Playwright found 0 tests. Scroll the stderr for the real import/syntax error that blocked the loader, fix the file, then re-run healix_test_my_app.',
  },

  GENERATED_TEST_SYNTAX_ERROR: {
    fixable: true,
    headline: 'A generated test file failed to parse.',
    diagnosticCommands: [
      { shell: 'echo "Open the failing spec path from the stderr — the line+column is printed."',
        purpose: 'The stderr contains the exact file:line:col.' },
    ],
    remediationSteps: [
      { kind: 'locate_failing_spec',
        from: 'stderr',
        pattern: /(tests\/generated\/[^\s:]+\.spec\.[tj]sx?)/i,
        description: 'Extract the spec path that failed to parse.' },
      { kind: 'surface_to_user_or_regenerate',
        description: 'Either delete the failing spec and re-run healix_test_my_app to regenerate it, or open it and fix the syntax error directly.' },
    ],
    retry: { tool: 'healix_test_my_app', reuseRunId: false },
    agentInstruction: 'A generated spec has a syntax error. Easiest fix: delete the specific failing spec (path is in the stderr) and re-run healix_test_my_app — Healix will regenerate it.',
  },

  EXPO_DEPENDENCY_VALIDATION_FAILED: {
    fixable: true,
    headline: 'Expo blocked startup on a dependency-version mismatch.',
    diagnosticCommands: [
      { shell: 'npx expo install --check || true',
        purpose: 'Let Expo report exactly which packages are off-version.' },
    ],
    remediationSteps: [
      { kind: 'shell',
        command: 'npx expo install --fix',
        description: 'Let Expo pin compatible versions automatically.' },
    ],
    retry: { tool: 'healix_test_my_app', reuseRunId: false },
    agentInstruction: 'Expo rejected the current dependency versions. Run `npx expo install --fix` in the project root to pin compatible versions, then re-run healix_test_my_app.',
  },

  ONLY_FALLBACK_SPECS_EXIST: {
    fixable: true,
    headline: 'Only Healix fallback stubs exist — enable generation and re-run.',
    diagnosticCommands: [
      { shell: 'ls tests/generated/ 2>/dev/null | grep -E "^fallback-|^__healix-"',
        purpose: 'Confirm the only specs are fallback stubs.' },
    ],
    remediationSteps: [
      { kind: 'surface_to_user',
        description: 'In the Healix config form, toggle "Generate tests" to ON before submitting. Re-running with generation OFF would just execute the same stub smoke tests again.' },
      { kind: 'shell',
        command: 'rm tests/generated/fallback-*.spec.* 2>/dev/null; true',
        description: 'Optional — remove the leftover fallback stubs so a fresh generation has a clean slate.',
        optional: true },
    ],
    retry: { tool: 'healix_test_my_app', reuseRunId: false },
    agentInstruction: 'Generation was disabled and only fallback stubs exist on disk. Tell the user to re-run with generation enabled (toggle in the config UI). Optionally delete tests/generated/fallback-*.spec.* first.',
  },

  PLAYWRIGHT_WEBSERVER_TIMEOUT: {
    fixable: true,
    headline: 'playwright.config `webServer` block is racing Healix\'s own dev-server manager — disable or align it.',
    diagnosticCommands: [
      { shell: 'grep -n "webServer" playwright.config.ts playwright.config.js playwright.config.mjs 2>/dev/null | head -20',
        purpose: 'Find the webServer block in the user\'s playwright.config.' },
    ],
    remediationSteps: [
      { kind: 'edit_file',
        description: 'Open the user\'s playwright.config.* and either (a) delete the `webServer: { ... }` block entirely so Healix owns the dev server, or (b) set `reuseExistingServer: true` AND make `webServer.url` match the baseURL/port configured in the Healix config form. The ports must be identical — port 5173 in the config but Healix on 5175 is the common failure mode.' },
      { kind: 'rerun_tool',
        description: 'Re-run healix_test_my_app. The dev server Healix starts will be the only one, and Playwright will talk to it directly.' },
    ],
    retry: { tool: 'healix_test_my_app', reuseRunId: false },
    agentInstruction: 'The user\'s playwright.config has a `webServer` block whose port/URL doesn\'t match the Healix-managed dev server. Edit playwright.config to either remove the `webServer` block or align its `url`/port with the baseURL you see in the Healix config UI. Then re-run.',
  },

  AGENTS_RETURNED_ZERO_TESTS: {
    fixable: false,
    headline: 'Every generation agent returned success but produced zero tests.',
    diagnosticCommands: [],
    remediationSteps: [
      { kind: 'surface_to_user',
        description: 'Root cause is typically OpenAI running past Vercel\'s 60s cap (so the webapp returns an empty tests[] for every agent). Ask the user to re-run — reasoning:"medium" is now the default for scoped agent calls. If it repeats, suggest flipping HEALIX_GEN_ASYNC=true on the webapp to route through Inngest.' },
    ],
    retry: { tool: 'healix_test_my_app', reuseRunId: false },
    agentInstruction: 'All agents returned 200 with an empty tests[] — not a code-level problem on the user\'s side. Surface to the user: re-run once; if it fails again, the webapp operator needs to flip HEALIX_GEN_ASYNC=true (Inngest async path) or shrink the project\'s PRD/exploration input. Do NOT try to patch the user\'s codebase.',
  },

  TIME_BUDGET_EXCEEDED: {
    fixable: false,
    headline: 'Healix hit its configured time budget before tests finished.',
    diagnosticCommands: [],
    remediationSteps: [
      { kind: 'surface_to_user',
        description: 'Ask the user to either raise HEALIX_TIMEOUT / the time budget in the config form, or reduce the coverage profile to a smaller tier.' },
    ],
    retry: { tool: 'healix_test_my_app', reuseRunId: false },
    agentInstruction: 'Healix ran out of its time budget. This is a config decision — surface to the user and ask whether to raise the budget or shrink the coverage profile, then re-run.',
  },

  GENERATION_VALIDATION_FAILED: {
    fixable: true,
    headline: 'Generated tests failed Playwright\'s pre-run validation.',
    diagnosticCommands: [
      { shell: 'echo "The stderr contains the exact playwright --list output."',
        purpose: 'playwright --list prints the offending file + line.' },
    ],
    remediationSteps: [
      { kind: 'rerun_tool',
        tool: 'healix_test_my_app',
        description: 'Sometimes a single bad spec is the cause; regenerating often produces a valid batch.' },
    ],
    retry: { tool: 'healix_test_my_app', reuseRunId: false },
    agentInstruction: 'Playwright\'s --list validation rejected the generated batch. First try re-running healix_test_my_app once — the generator is non-deterministic. If it fails the same way twice, open the specific spec named in the stderr and delete or fix it.',
  },

  PIPELINE_FAILED: {
    fixable: false,
    headline: 'Pipeline exited before any test reported a result.',
    diagnosticCommands: [],
    remediationSteps: [
      { kind: 'surface_to_user',
        description: 'Generic fallback — the dashboard banner has the full stderr + first-generated-spec preview.' },
    ],
    retry: { tool: 'healix_check_run_status', reuseRunId: true },
    agentInstruction: 'Healix hit a generic pipeline failure. Open the dashboard banner (it shows stderr + first-spec preview), then decide with the user whether to re-run.',
  },
};

/**
 * Look up a remediation by errorCode. Returns `null` when the code is unknown
 * so callers can fall back to the human-readable message.
 */
function getRemediationForErrorCode(errorCode) {
  if (!errorCode || typeof errorCode !== 'string') return null;
  return REMEDIATIONS[errorCode] ?? null;
}

/**
 * Build the agent-facing remediation block for a terminal pipeline error.
 *
 * Shape:
 *   {
 *     errorCode,
 *     headline,              // one-liner
 *     fixable,               // boolean
 *     agentInstruction,      // natural-language instruction for the agent
 *     diagnosticCommands,    // read-only probes
 *     remediationSteps,      // ordered fix steps
 *     retry,                 // how to resume Healix
 *     fallbackMessage,       // human-readable fallback if the registry misses
 *   }
 *
 * When the errorCode is unknown, returns a generic "surface-to-user" block
 * built from `fallbackMessage` so the agent still has something to do.
 */
function buildRemediationBlock({ errorCode, fallbackMessage = null } = {}) {
  const entry = getRemediationForErrorCode(errorCode);
  if (entry) {
    return {
      errorCode: errorCode || null,
      headline: entry.headline,
      fixable: entry.fixable === true,
      agentInstruction: entry.agentInstruction,
      diagnosticCommands: Array.isArray(entry.diagnosticCommands) ? entry.diagnosticCommands : [],
      remediationSteps: Array.isArray(entry.remediationSteps) ? entry.remediationSteps : [],
      retry: entry.retry || null,
      fallbackMessage: fallbackMessage || null,
    };
  }
  return {
    errorCode: errorCode || null,
    headline: fallbackMessage || 'Healix pipeline terminated with an unclassified error.',
    fixable: false,
    agentInstruction: 'Healix terminated with an error Healix does not yet auto-remediate. Relay the errorCode + message + dashboardUrl to the user and ask how to proceed.',
    diagnosticCommands: [],
    remediationSteps: [
      { kind: 'surface_to_user',
        description: fallbackMessage || 'No pre-canned remediation is available for this errorCode.' },
    ],
    retry: { tool: 'healix_test_my_app', reuseRunId: false },
    fallbackMessage: fallbackMessage || null,
  };
}

/**
 * Format a remediation block as plain-text markdown so the agent can inline it
 * in its chat response. Called by handleCheckRunStatus when no T7 report
 * exists (pipeline-error case).
 */
function formatRemediationBlock(block) {
  if (!block) return '';
  const lines = ['## AGENT REMEDIATION'];
  lines.push(`- errorCode: ${block.errorCode || 'UNCLASSIFIED'}`);
  lines.push(`- fixable: ${block.fixable ? 'yes (attempt without asking the user)' : 'no (surface to user)'}`);
  lines.push(`- headline: ${block.headline}`);
  lines.push('');
  lines.push(`> ${block.agentInstruction}`);

  if (block.diagnosticCommands.length > 0) {
    lines.push('', '### Diagnostic commands (read-only):');
    block.diagnosticCommands.forEach((d, i) => {
      lines.push(`${i + 1}. \`${d.shell}\``);
      if (d.purpose) lines.push(`   — ${d.purpose}`);
    });
  }

  if (block.remediationSteps.length > 0) {
    lines.push('', '### Remediation steps (run in order):');
    block.remediationSteps.forEach((s, i) => {
      if (s.kind === 'shell') {
        const bg = s.runInBackground ? ' (run in background)' : '';
        const opt = s.optional ? ' (optional)' : '';
        lines.push(`${i + 1}. Run: \`${s.command}\`${bg}${opt}`);
        if (s.description) lines.push(`   — ${s.description}`);
        if (s.alternates) {
          const alts = Object.entries(s.alternates).map(([pm, cmd]) => `${pm}: \`${cmd}\``).join(' · ');
          lines.push(`   alternates: ${alts}`);
        }
      } else if (s.kind === 'wait_for_url') {
        lines.push(`${i + 1}. Wait for \`${s.url}\` to respond (timeout ${Math.round((s.timeoutMs || 60000) / 1000)}s).`);
        if (s.description) lines.push(`   — ${s.description}`);
      } else if (s.kind === 'rerun_tool') {
        lines.push(`${i + 1}. Call MCP tool \`${s.tool}\` again.`);
        if (s.description) lines.push(`   — ${s.description}`);
      } else if (s.kind === 'surface_to_user') {
        lines.push(`${i + 1}. Surface to user: ${s.description || '(no details)'}`);
      } else {
        lines.push(`${i + 1}. ${s.kind}${s.description ? ' — ' + s.description : ''}`);
      }
    });
  }

  if (block.retry) {
    lines.push('', '### After fixing:');
    lines.push(`- Call \`${block.retry.tool}\`${block.retry.reuseRunId ? ' with the same runId' : ' with the original projectPath (new runId OK)'}.`);
  }

  return lines.join('\n');
}

module.exports = {
  REMEDIATIONS,
  getRemediationForErrorCode,
  buildRemediationBlock,
  formatRemediationBlock,
};
