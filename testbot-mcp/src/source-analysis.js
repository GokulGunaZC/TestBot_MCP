'use strict';

/**
 * Static source-code analysis fallback for exploration.
 *
 * When both browser-use and Playwright heuristic exploration fail (typically
 * because the dev server is not yet running at analysis time), this module
 * reads the target project's source files and extracts the DOM/form knowledge
 * the generator would otherwise receive from a live browser crawl:
 *
 *   - Input fields: id, type, aria-label, label text, placeholder
 *   - Select elements vs checkbox/radio groups (so the generator knows not to
 *     call selectOption() on checkboxes)
 *   - Non-form elements that carry aria-label (footer links, icon buttons) —
 *     flagged as potential getByLabel strict-mode hazards
 *   - Route structure from Next.js app/ or pages/ directories
 *   - Auth middleware redirect targets (redirects to /login vs /)
 *
 * Returns a partial ExplorationArtifact that can be merged with an empty one.
 */

const fs = require('fs');
const path = require('path');

const SOURCE_EXTENSIONS = new Set(['.tsx', '.jsx', '.ts', '.js', '.html', '.vue', '.svelte']);
const MAX_FILES = 120;
const MAX_FILE_SIZE = 80_000; // skip minified/generated files

// ── Regex patterns ──────────────────────────────────────────────────────────

// <input id="x" type="email" ...>  — captures id and type
const INPUT_RE = /<input\b([^>]*?)(?:\/>|>)/gi;
// <select id="x" ...>
const SELECT_RE = /<select\b([^>]*?)(?:>|\/?>)/gi;
// <label ... htmlFor="x"> or <label for="x">
const LABEL_FOR_RE = /(?:htmlFor|for)=["']([^"']+)["']/gi;
// <label ...>Text</label>
const LABEL_TEXT_RE = /<label\b[^>]*>([\s\S]*?)<\/label>/gi;
// aria-label="..." on any element
const ARIA_LABEL_RE = /aria-label=["']([^"']+)["']/gi;
// role="..." attribute (detect non-form roles that could conflict)
const ARIA_ROLE_RE = /\brole=["']([^"']+)["']/gi;

function extractAttr(attrString, attrName) {
  const re = new RegExp(`\\b${attrName}=["']([^"']*)["']`, 'i');
  const m = attrString.match(re);
  return m ? m[1] : null;
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, '').trim().slice(0, 60);
}

/**
 * Collect all source files under projectPath, skipping common non-source dirs.
 */
function collectSourceFiles(projectPath) {
  const SKIP_DIRS = new Set([
    'node_modules', '.next', '.git', 'dist', 'build', 'out',
    '.cache', 'coverage', '__tests__', '.healix', 'healix-reports',
    'drizzle', 'migrations', 'public',
  ]);

  const files = [];

  function walk(dir) {
    if (files.length >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          walk(path.join(dir, entry.name));
        }
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(path.join(dir, entry.name));
      }
    }
  }

  walk(projectPath);
  return files;
}

/**
 * Extract form field metadata from a single source file's content.
 * Returns { inputs, selects, ariaLabelElements }
 */
function extractFormMetadata(content) {
  const inputs = [];
  const selects = [];
  const ariaLabelElements = [];

  // --- inputs ---
  let m;
  INPUT_RE.lastIndex = 0;
  while ((m = INPUT_RE.exec(content)) !== null) {
    const attrs = m[1];
    const id = extractAttr(attrs, 'id');
    const type = extractAttr(attrs, 'type') || 'text';
    const ariaLabel = extractAttr(attrs, 'aria-label');
    const placeholder = extractAttr(attrs, 'placeholder');
    const name = extractAttr(attrs, 'name');
    inputs.push({ id, type, ariaLabel, placeholder, name });
  }

  // --- selects ---
  SELECT_RE.lastIndex = 0;
  while ((m = SELECT_RE.exec(content)) !== null) {
    const attrs = m[1];
    const id = extractAttr(attrs, 'id');
    const name = extractAttr(attrs, 'name');
    const ariaLabel = extractAttr(attrs, 'aria-label');
    selects.push({ id, name, ariaLabel });
  }

  // --- aria-label on non-input elements (potential getByLabel hazards) ---
  ARIA_LABEL_RE.lastIndex = 0;
  while ((m = ARIA_LABEL_RE.exec(content)) !== null) {
    // Check what element tag precedes this aria-label by looking back ~60 chars
    const before = content.slice(Math.max(0, m.index - 60), m.index);
    const tagMatch = before.match(/<(\w+)[^>]*$/);
    const tag = tagMatch ? tagMatch[1].toLowerCase() : 'unknown';
    // Non-form elements with aria-label create strict-mode hazards for getByLabel
    if (!['input', 'select', 'textarea', 'button'].includes(tag)) {
      ariaLabelElements.push({ tag, label: m[1].trim().slice(0, 80) });
    }
  }

  return { inputs, selects, ariaLabelElements };
}

/**
 * Extract label associations (htmlFor / for) and their visible text.
 */
function extractLabelAssociations(content) {
  const associations = {};

  // Labels with htmlFor="id"
  let m;
  LABEL_FOR_RE.lastIndex = 0;
  while ((m = LABEL_FOR_RE.exec(content)) !== null) {
    const forId = m[1];
    // Look for the text of this label element
    const labelStart = content.lastIndexOf('<label', m.index);
    if (labelStart !== -1) {
      const labelEnd = content.indexOf('</label>', m.index);
      if (labelEnd !== -1) {
        const labelHtml = content.slice(labelStart, labelEnd + 8);
        associations[forId] = stripHtml(labelHtml);
      }
    }
  }

  return associations;
}

/**
 * Discover route paths from Next.js app/ or pages/ directory structure.
 */
function discoverRoutes(projectPath) {
  const routes = [];
  for (const base of ['app', 'pages', 'src/app', 'src/pages']) {
    const dir = path.join(projectPath, base);
    if (!fs.existsSync(dir)) continue;

    function walkRoutes(d, prefix) {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
          // Next.js dynamic segments: [id] → :id
          const seg = entry.name.replace(/^\[(.+)\]$/, ':$1');
          walkRoutes(path.join(d, entry.name), `${prefix}/${seg}`);
        } else if (/page\.(tsx|jsx|ts|js)$/.test(entry.name)) {
          routes.push(prefix || '/');
        }
      }
    }

    walkRoutes(dir, '');
    if (routes.length > 0) break;
  }
  return [...new Set(routes)].slice(0, 30);
}

/**
 * Check for auth middleware and detect redirect targets.
 * Returns { hasMiddleware, redirectsAuthTo } where redirectsAuthTo is '/login' or '/' etc.
 */
function detectAuthMiddleware(projectPath) {
  const middlewarePaths = [
    'middleware.ts', 'middleware.js',
    'src/middleware.ts', 'src/middleware.js',
  ];

  for (const rel of middlewarePaths) {
    const full = path.join(projectPath, rel);
    try {
      const content = fs.readFileSync(full, 'utf-8');
      // Look for redirect patterns like url.pathname = '/login'
      const loginRedirect = /pathname\s*=\s*['"]\/login['"]/.test(content);
      const homeRedirect = /pathname\s*=\s*['"]\/['"]/.test(content);
      // Which routes does the middleware protect?
      const protectsAdmin = /pathname\.startsWith\(['"]\/admin['"]/.test(content)
        || /\/admin/.test(content);
      const protectsAccount = /pathname\.startsWith\(['"]\/account['"]/.test(content)
        || /\/account/.test(content);

      return {
        hasMiddleware: true,
        unauthRedirectsTo: loginRedirect ? '/login' : (homeRedirect ? '/' : '/login'),
        protectedPaths: [
          ...(protectsAdmin ? ['/admin'] : []),
          ...(protectsAccount ? ['/account'] : []),
        ],
      };
    } catch { /* not found */ }
  }

  return { hasMiddleware: false, unauthRedirectsTo: '/login', protectedPaths: [] };
}

/**
 * Main entry point. Analyzes a project's source files and returns a partial
 * ExplorationArtifact enriched with DOM/form metadata.
 *
 * @param {string} projectPath - absolute path to the target project
 * @returns {{ selectorHints: Array, formMetadata: Array, ariaLabelHazards: Array, routes: Array, authInfo: object }}
 */
function analyzeProjectSource(projectPath) {
  const files = collectSourceFiles(projectPath);

  const allInputs = [];
  const allSelects = [];
  const ariaHazards = [];
  const labelMaps = [];

  for (const file of files) {
    let content;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_FILE_SIZE) continue;
      content = fs.readFileSync(file, 'utf-8');
    } catch { continue; }

    const { inputs, selects, ariaLabelElements } = extractFormMetadata(content);
    const labels = extractLabelAssociations(content);

    // Annotate inputs with their label text
    for (const inp of inputs) {
      if (inp.id && labels[inp.id]) inp.labelText = labels[inp.id];
      inp.sourceFile = path.relative(projectPath, file);
      allInputs.push(inp);
    }
    for (const sel of selects) {
      sel.sourceFile = path.relative(projectPath, file);
      allSelects.push(sel);
    }
    ariaHazards.push(...ariaLabelElements);
    labelMaps.push(labels);
  }

  // De-duplicate inputs by id+type
  const seen = new Set();
  const uniqueInputs = allInputs.filter((inp) => {
    const key = `${inp.id || ''}-${inp.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Build selector hints for the generator
  const selectorHints = [];
  for (const inp of uniqueInputs) {
    if (inp.id) {
      selectorHints.push({
        description: `${inp.labelText || inp.ariaLabel || inp.name || inp.type} input`,
        selector: `#${inp.id}`,
        type: inp.type,
        preferredLocator: `page.locator('#${inp.id}')`,
      });
    }
  }
  for (const sel of allSelects) {
    if (sel.id) {
      selectorHints.push({
        description: `${sel.ariaLabel || sel.name || 'select'} dropdown`,
        selector: `#${sel.id}`,
        type: 'select',
        preferredLocator: `page.locator('#${sel.id}')`,
      });
    }
  }

  // Unique aria hazards — these warn the generator about non-form elements
  // that carry aria-label and will conflict with getByLabel() calls
  const uniqueHazards = [];
  const hazardSeen = new Set();
  for (const h of ariaHazards) {
    const key = `${h.tag}:${h.label.toLowerCase()}`;
    if (!hazardSeen.has(key)) {
      hazardSeen.add(key);
      uniqueHazards.push(h);
    }
  }

  const routes = discoverRoutes(projectPath);
  const authInfo = detectAuthMiddleware(projectPath);

  return {
    selectorHints: selectorHints.slice(0, 40),
    formMetadata: {
      inputs: uniqueInputs.slice(0, 30),
      selects: allSelects.slice(0, 15),
    },
    ariaLabelHazards: uniqueHazards.slice(0, 20),
    discoveredRoutes: routes,
    authInfo,
    analyzedFileCount: files.length,
  };
}

module.exports = { analyzeProjectSource };
