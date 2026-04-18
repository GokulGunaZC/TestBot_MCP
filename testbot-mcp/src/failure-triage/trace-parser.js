/**
 * Playwright trace-parser — minimal slice of trace.zip extracted for triage.
 *
 * Playwright writes a trace.zip for every retained-on-failure run. The archive
 * contains `trace.trace` (NDJSON events) and sometimes `trace.network`. We
 * extract just enough structured signal for the classifier and the two-
 * hypothesis AI prompt:
 *
 *   - failedAction: which locator or step threw, with error text
 *   - domAtFailure: the smallest useful DOM slice (visible buttons, inputs,
 *     body sample) at the moment of failure
 *   - networkAtFailure: last 10 requests before failure
 *   - consoleAtFailure: last 10 console messages
 *
 * We cap the total evidence at ~4 KB per failure so the downstream AI call
 * stays cheap and stays under rate limits.
 *
 * If the trace is missing, unreadable, or doesn't fit the expected shape we
 * return a best-effort object with { parseError } set; callers use it as a
 * soft signal rather than a hard requirement.
 */

const fs = require('fs');
const path = require('path');

let yauzl;
try {
  yauzl = require('yauzl');
} catch {
  yauzl = null;
}

const MAX_NETWORK_EVENTS = 10;
const MAX_CONSOLE_EVENTS = 10;
const MAX_BODY_SAMPLE = 800;
const MAX_BUTTON_LABELS = 16;
const MAX_INPUT_LABELS = 12;

/**
 * Open a trace.zip and stream the raw NDJSON text of `trace.trace`.
 * Returns { traceText, networkText } (strings or null) on success.
 */
function readTraceFile(zipPath) {
  return new Promise((resolve) => {
    if (!yauzl) {
      resolve({ error: 'yauzl_unavailable' });
      return;
    }

    if (!zipPath || !fs.existsSync(zipPath)) {
      resolve({ error: 'trace_missing' });
      return;
    }

    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err) {
        resolve({ error: 'trace_open_failed', details: err.message });
        return;
      }

      const out = { traceText: null, networkText: null };

      zipfile.on('entry', (entry) => {
        const name = String(entry.fileName || '');
        const isTrace = name.endsWith('trace.trace');
        const isNetwork = name.endsWith('trace.network');
        if (!isTrace && !isNetwork) {
          zipfile.readEntry();
          return;
        }

        zipfile.openReadStream(entry, (readErr, stream) => {
          if (readErr) {
            zipfile.readEntry();
            return;
          }
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            if (isTrace) out.traceText = text;
            if (isNetwork) out.networkText = text;
            zipfile.readEntry();
          });
          stream.on('error', () => zipfile.readEntry());
        });
      });

      zipfile.on('end', () => resolve(out));
      zipfile.on('error', () => resolve({ error: 'trace_iteration_failed' }));
      zipfile.readEntry();
    });
  });
}

/**
 * Parse the NDJSON trace text into an ordered list of events.
 * We tolerate partial lines and never throw.
 */
function parseTraceEvents(traceText) {
  if (typeof traceText !== 'string' || !traceText.length) return [];
  const events = [];
  for (const line of traceText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // ignore malformed lines — traces can contain partials
    }
  }
  return events;
}

/**
 * Extract a short, diagnostic slice from the full parsed event stream.
 */
function summariseEvents(events) {
  const summary = {
    failedAction: null,
    domAtFailure: {
      bodyTextSample: '',
      visibleButtons: [],
      visibleInputs: [],
    },
    networkAtFailure: [],
    consoleAtFailure: [],
    preFailureScreenshot: null,
  };

  if (!Array.isArray(events) || events.length === 0) return summary;

  // Walk events forward to find the failing action — Playwright records the
  // action-level result on `after` events where `error` is populated.
  let failedIndex = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i] || {};
    const type = ev.type || ev.event || '';
    const error = ev?.error?.message || ev?.error || null;
    if ((type === 'after' || type === 'action') && error) {
      summary.failedAction = {
        name: ev?.method || ev?.action || ev?.apiName || 'unknown',
        selector: ev?.params?.selector || ev?.selector || null,
        url: ev?.params?.url || ev?.url || null,
        errorText: typeof error === 'string' ? error.slice(0, 600) : String(error).slice(0, 600),
      };
      failedIndex = i;
      break;
    }
  }

  // Network + console trailers — take the last N before the failure point.
  // If we never found a failed action, take the last N overall.
  const endIdx = failedIndex >= 0 ? failedIndex : events.length;
  const network = [];
  const consoleLines = [];

  for (let i = endIdx - 1; i >= 0 && (network.length < MAX_NETWORK_EVENTS || consoleLines.length < MAX_CONSOLE_EVENTS); i--) {
    const ev = events[i] || {};
    const type = ev.type || ev.event || '';

    if ((type === 'resource' || ev?.class === 'Resource' || ev?.method === 'Network.responseReceived') && network.length < MAX_NETWORK_EVENTS) {
      const meta = ev.metadata || ev.params || ev;
      network.unshift({
        url: String(meta?.request?.url || meta?.url || '').slice(0, 240),
        method: String(meta?.request?.method || meta?.method || '').slice(0, 8),
        status: Number(meta?.response?.status || meta?.status || 0) || 0,
        duration: Number(meta?.duration || 0) || 0,
      });
    }

    if ((type === 'console' || ev?.method === 'Runtime.consoleAPICalled') && consoleLines.length < MAX_CONSOLE_EVENTS) {
      const text = ev?.text || ev?.message || ev?.params?.args?.map((a) => a?.value || a?.description || '').join(' ') || '';
      if (text) consoleLines.unshift(String(text).slice(0, 240));
    }
  }

  summary.networkAtFailure = network;
  summary.consoleAtFailure = consoleLines;

  // Body/selector DOM slice — Playwright snapshots pages into special events.
  // We look for the most recent `frame-snapshot` before the failure.
  for (let i = endIdx - 1; i >= 0; i--) {
    const ev = events[i] || {};
    const type = ev.type || ev.event || '';
    if (type === 'frame-snapshot' || type === 'screencast-frame' || ev?.snapshot) {
      const html = ev?.snapshot?.html || ev?.html || '';
      if (typeof html === 'string' && html.length > 0) {
        summary.domAtFailure.bodyTextSample = extractBodyText(html).slice(0, MAX_BODY_SAMPLE);
        summary.domAtFailure.visibleButtons = extractByTag(html, 'button', MAX_BUTTON_LABELS);
        summary.domAtFailure.visibleInputs = extractByTag(html, 'input', MAX_INPUT_LABELS, (match) => {
          const nameAttr = /name=["']?([^"'\s>]+)/i.exec(match);
          const placeholder = /placeholder=["']([^"']+)/i.exec(match);
          return nameAttr?.[1] || placeholder?.[1] || 'unnamed';
        });
        break;
      }
    }
  }

  return summary;
}

function extractBodyText(html) {
  const match = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html || '');
  const raw = match ? match[1] : String(html || '');
  return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractByTag(html, tag, limit, transform) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const out = [];
  let match;
  while ((match = re.exec(html)) !== null && out.length < limit) {
    if (transform) {
      out.push(transform(match[0]));
      continue;
    }
    const inner = match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (inner) out.push(inner.slice(0, 80));
  }
  return out;
}

/**
 * Parse a Playwright trace.zip into a TraceEvidence object.
 *
 * Never throws — returns { parseError } on any failure path.
 */
async function parseTrace(tracePath) {
  try {
    const raw = await readTraceFile(tracePath);
    if (raw?.error) {
      return emptyEvidence({ parseError: raw.error });
    }

    const events = parseTraceEvents(raw.traceText);
    const summary = summariseEvents(events);

    // If the trace is dense (many events) but we still extracted nothing,
    // mark the evidence as degraded so callers can downgrade confidence.
    if (events.length === 0 && !summary.failedAction) {
      return emptyEvidence({ parseError: 'empty_trace' });
    }

    return {
      ...summary,
      parseError: null,
      source: {
        tracePath,
        eventCount: events.length,
      },
    };
  } catch (err) {
    return emptyEvidence({ parseError: err?.message || 'unexpected' });
  }
}

function emptyEvidence(extras = {}) {
  return {
    failedAction: null,
    domAtFailure: { bodyTextSample: '', visibleButtons: [], visibleInputs: [] },
    networkAtFailure: [],
    consoleAtFailure: [],
    preFailureScreenshot: null,
    ...extras,
  };
}

/**
 * Convenience helper — given an artifacts block from a Playwright test result,
 * pick the most likely trace path (traces[0] or traces[0].fullPath).
 */
function resolveTracePath(artifacts, projectPath) {
  if (!artifacts) return null;
  const traces = Array.isArray(artifacts.traces) ? artifacts.traces : [];
  for (const t of traces) {
    const candidate = t?.fullPath || t?.path || t?.file || null;
    if (!candidate) continue;
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
    const joined = path.join(projectPath || process.cwd(), candidate);
    if (fs.existsSync(joined)) return joined;
  }
  return null;
}

module.exports = {
  parseTrace,
  resolveTracePath,
};
