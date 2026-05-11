#!/usr/bin/env python3
"""Healix browser-use runner.

Drives `browser-use` Agent against HEALIX_TARGET_URL and emits an
`ExplorationArtifact` over stdout as NDJSON. Events:

    {"type": "ready", "target": "..."}
    {"type": "heartbeat", "ts": "..."}
    {"type": "progress", "message": "..."}
    {"type": "artifact", "data": { routes, forms, authFlow, keyFlows, observedErrors }}
    {"type": "error", "reason": "..."}

Exit codes:
    0  artifact emitted
    1  runtime failure (reason emitted)
    2  dependency missing (browser-use or no LLM credentials); driver falls back

Design notes:
    - We prefer `browser-use`'s structured-output API (output_model) when the
      installed version supports it. If the API differs, we fall back to
      parsing a JSON block out of the agent's final text.
    - Heartbeats run on a background thread so the Node driver's watchdog
      stays fed while the LLM loop is thinking.
    - Credentials are consumed read-only — they enter the Agent's task text
      but never get logged.

Env inputs:
    HEALIX_TARGET_URL       - base URL to explore (required)
    HEALIX_LOGIN_USERNAME   - optional credential
    HEALIX_LOGIN_PASSWORD   - optional credential
    HEALIX_TOTAL_TIMEOUT_S  - hard cap in seconds (default 180)
    HEALIX_BROWSER_USE_MODEL- OpenAI model id (default "gpt-4o-mini")

    LLM credentials (set automatically by the Node driver):
    HEALIX_API_KEY          - routes LLM calls through the Healix webapp proxy.
    HEALIX_LLM_PROXY_URL   - base URL of the LLM proxy, e.g.
                              http://localhost:3000/api/llm-proxy
                              (derived from HEALIX_DASHBOARD_URL by the driver).
"""

import asyncio
import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone


def _emit(event):
    try:
        sys.stdout.write(json.dumps(event) + "\n")
        sys.stdout.flush()
    except Exception:
        # Best-effort — if stdout is closed (driver killed us) just die quietly.
        pass


def _heartbeat_loop(stop_event):
    while not stop_event.is_set():
        _emit({"type": "heartbeat", "ts": datetime.now(timezone.utc).isoformat()})
        stop_event.wait(1.0)


_ARTIFACT_TEMPLATE = {
    "routes": [],
    "forms": [],
    "authFlow": None,
    "keyFlows": [],
    "observedErrors": [],
}


def _build_task(target_url, username, password):
    all_roles_raw = os.environ.get("HEALIX_ALL_ROLES", "")
    roles_note = (
        f" The app has multiple roles ({all_roles_raw}) — note any role-specific pages."
        if all_roles_raw else ""
    )

    if username and password:
        login_block = (
            f"\nSTEP 1 — LOGIN (mandatory, do this first):\n"
            f"  Navigate to {target_url}.\n"
            f"  If you land on a login page OR get redirected to one, fill in\n"
            f"  the username/email field with {username!r} and the password field\n"
            f"  with {password!r}, then click the submit button.\n"
            f"  Do NOT use register, signup, create-account, or onboarding forms\n"
            f"  as login forms. If both /login and /register exist, loginUrl MUST\n"
            f"  point to the sign-in/login page only.\n"
            f"  Wait for the authenticated page to load before continuing.\n"
            f"  Record loginUrl, credentialFields selectors, successIndicator, failureIndicator.\n"
        )
        nav_start = "STEP 2"
    else:
        login_block = f"\nSTEP 1 — Start at {target_url}.\n"
        nav_start = "STEP 2"

    return (
        f"GOAL: Rapidly map the route structure of {target_url}.\n"
        f"SPEED RULE: Spend at most 10 seconds per page. Breadth over depth.\n"
        f"OUTPUT: One JSON object only — no prose before or after.\n"
        "STOP RULE: Use the final/done response with the JSON and then stop. "
        "Do not write files. If a detail tool cannot extract a form, use the "
        "visible DOM labels/names/placeholders you can see and continue.\n"
        "\nSchema:\n"
        '{"routes":[{"path":string,"requiresAuth":boolean,"elements":[{"role":string,"name":string,"selector":string}]}],'
        '"forms":[{"route":string,"fields":[{"name":string,"type":string,"required":boolean}],"submitLabel":string}],'
        '"authFlow":{"loginUrl":string,"credentialFields":{"username":string,"password":string},"successIndicator":string,"failureIndicator":string}|null,'
        '"keyFlows":[{"name":string,"steps":[{"action":string,"target":string,"value":string|null}],"endCondition":string}],'
        '"observedErrors":[string]}\n'
        f"{login_block}"
        f"\n{nav_start} — NAVIGATE (visit up to 12 distinct routes):\n"
        "  Click every link in the sidebar, top navbar, or main menu.\n"
        "  On each page: scroll to the bottom once, collect the page path and\n"
        "  up to 5 interactive elements, then IMMEDIATELY move to the next link.\n"
        "  Do NOT re-visit paths already recorded.\n"
        "\nSTEP 3 — FORMS: For each page with a non-login form, record its fields.\n"
        "\nSTEP 4 — FLOWS: Identify up to 3 key user flows (e.g. create, edit, delete).\n"
        "\nSTEP 5 — OUTPUT the JSON via final/done. Do NOT include any text outside the JSON block.\n"
        f"{roles_note}"
    )


def _extract_json(text):
    if not text:
        return None
    # Grab the first balanced {...} block. Use a greedy fallback regex since
    # the agent sometimes wraps JSON in code fences or prose.
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```[a-zA-Z0-9_]*\n?", "", stripped)
        stripped = re.sub(r"\n?```\s*$", "", stripped)
    candidates = []
    depth = 0
    start = -1
    for i, ch in enumerate(stripped):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start != -1:
                candidates.append(stripped[start : i + 1])
                start = -1
    for cand in reversed(candidates):  # prefer the last (outermost) block
        try:
            return json.loads(cand)
        except json.JSONDecodeError:
            continue
    return None


def _normalize_artifact(parsed):
    artifact = {k: v for k, v in _ARTIFACT_TEMPLATE.items()}
    if not isinstance(parsed, dict):
        return artifact
    for key in ("routes", "forms", "keyFlows", "observedErrors"):
        if isinstance(parsed.get(key), list):
            artifact[key] = parsed[key]
    if isinstance(parsed.get("authFlow"), dict):
        artifact["authFlow"] = parsed["authFlow"]
    return artifact


def _build_cloud_llm():
    for import_path, ctor in (
        ("browser_use.llm", "ChatBrowserUse"),
        ("browser_use", "ChatBrowserUse"),
    ):
        try:
            module = __import__(import_path, fromlist=[ctor])
            cls = getattr(module, ctor)
            return cls()
        except Exception:
            continue
    return None


def _build_openai_compatible_llm(model, api_key, base_url=None):
    for import_path, ctor in (
        ("browser_use.llm", "ChatOpenAI"),
        ("browser_use", "ChatOpenAI"),
        ("langchain_openai", "ChatOpenAI"),
    ):
        try:
            module = __import__(import_path, fromlist=[ctor])
            cls = getattr(module, ctor)
            kwargs = {"model": model, "api_key": api_key, "temperature": 0}
            if base_url:
                kwargs["base_url"] = base_url
            llm = cls(**kwargs)
            return llm
        except Exception:
            continue
    return None


def _build_llm():
    """Construct the browser-use LLM instance.

    Prefer the Healix webapp proxy when available. Browser Use Cloud keys may
    exist on developer machines, but some account tiers reject LLM Gateway
    calls at runtime; the proxy path is the stable default because Healix owns
    the server-side OpenAI configuration.
    """
    model = os.environ.get("HEALIX_BROWSER_USE_MODEL", "gpt-4o-mini")
    api_key = os.environ.get("HEALIX_API_KEY")
    base_url = os.environ.get("HEALIX_LLM_PROXY_URL")
    openai_api_key = os.environ.get("OPENAI_API_KEY")
    openai_base_url = os.environ.get("OPENAI_BASE_URL") or os.environ.get("OPENAI_API_BASE")
    provider = os.environ.get("HEALIX_BROWSER_USE_PROVIDER", "").strip().lower()
    has_cloud_key = bool(os.environ.get("BROWSER_USE_API_KEY") or os.environ.get("HEALIX_BROWSER_USE_API_KEY"))
    has_proxy = bool(api_key and base_url)
    has_direct_openai = bool(openai_api_key)

    if has_proxy and provider not in {"cloud", "browser-use", "browser_use"}:
        llm = _build_openai_compatible_llm(model, api_key, base_url)
        if llm is not None:
            return llm, "healix_proxy"

    if has_direct_openai and provider in {"openai", "direct", "local"}:
        llm = _build_openai_compatible_llm(model, openai_api_key, openai_base_url)
        if llm is not None:
            return llm, "direct_openai"

    if has_cloud_key:
        llm = _build_cloud_llm()
        if llm is not None:
            return llm, "browser_use_cloud"

    if has_direct_openai:
        llm = _build_openai_compatible_llm(model, openai_api_key, openai_base_url)
        if llm is not None:
            return llm, "direct_openai"

    if has_proxy:
        llm = _build_openai_compatible_llm(model, api_key, base_url)
        if llm is not None:
            return llm, "healix_proxy"

    return None, None


async def _drive_agent(target_url, username, password, timeout_s):
    try:
        from browser_use import Agent  # type: ignore
    except ImportError as exc:
        _emit({"type": "error", "reason": f"browser-use import failed: {exc}"})
        return None

    llm, llm_provider = _build_llm()
    if llm is None:
        _emit({"type": "error", "reason": "Could not construct LLM — check BROWSER_USE_API_KEY or HEALIX_API_KEY/HEALIX_LLM_PROXY_URL"})
        return None

    if llm_provider == "browser_use_cloud":
        _emit({"type": "progress", "message": "LLM routed through Browser Use Cloud"})
    elif llm_provider == "direct_openai":
        _emit({"type": "progress", "message": "LLM routed through direct OpenAI-compatible API"})
    else:
        _emit({"type": "progress", "message": "LLM routed through Healix webapp proxy"})

    task = _build_task(target_url, username, password)

    # Build Agent kwargs with speed optimisations, falling back gracefully
    # when a browser-use version doesn't support a particular parameter.
    import inspect
    agent_kwargs: dict = {"task": task, "llm": llm}
    try:
        sig_params = inspect.signature(Agent.__init__).parameters
        # Skip screenshot capture — text/DOM is sufficient for route mapping and
        # avoids the base64-encode + LLM-vision overhead on every step (~2-3x faster).
        if "use_vision" in sig_params:
            agent_kwargs["use_vision"] = False
        # Cap total steps so the agent can't get stuck on one page for 100 turns.
        if "max_steps" in sig_params:
            agent_kwargs["max_steps"] = 25
        # Allow several browser actions per LLM call — fewer round-trips = faster.
        if "max_actions_per_step" in sig_params:
            agent_kwargs["max_actions_per_step"] = 5
        if "max_failures" in sig_params:
            agent_kwargs["max_failures"] = 3
        if "llm_timeout" in sig_params:
            agent_kwargs["llm_timeout"] = 30
        if "step_timeout" in sig_params:
            agent_kwargs["step_timeout"] = 45
        if "use_judge" in sig_params:
            agent_kwargs["use_judge"] = False
        if "enable_planning" in sig_params:
            agent_kwargs["enable_planning"] = False
        if "use_thinking" in sig_params:
            agent_kwargs["use_thinking"] = False
        if "max_history_items" in sig_params:
            agent_kwargs["max_history_items"] = 10

        # Headless mode: default true so exploration runs silently in the background.
        # Set HEALIX_BROWSER_HEADLESS=false to show the browser window (debug only).
        headless_raw = os.environ.get("HEALIX_BROWSER_HEADLESS", "true").strip().lower()
        headless = headless_raw not in ("false", "0", "no")
        if "browser_profile" in sig_params:
            try:
                from browser_use.browser.profile import BrowserProfile  # type: ignore
                agent_kwargs["browser_profile"] = BrowserProfile(headless=headless)
            except Exception:
                pass  # older version without BrowserProfile — leave default
    except Exception:
        pass  # version doesn't expose these params; proceed with defaults

    try:
        agent = Agent(**agent_kwargs)
    except TypeError as exc:
        _emit({"type": "error", "reason": f"Agent API mismatch: {exc}"})
        return None
    except Exception as exc:
        _emit({"type": "error", "reason": f"Agent construction failed: {type(exc).__name__}: {exc}"})
        return None

    _emit({"type": "progress", "message": "agent launched"})

    max_steps = 10
    try:
        max_steps = max(3, min(20, int(os.environ.get("HEALIX_BROWSER_USE_MAX_STEPS", "10"))))
    except ValueError:
        max_steps = 10

    try:
        result = await asyncio.wait_for(agent.run(max_steps=max_steps), timeout=timeout_s)
    except asyncio.TimeoutError:
        _emit({"type": "error", "reason": f"browser-use agent exceeded {timeout_s}s timeout"})
        return None
    except Exception as exc:
        _emit({"type": "error", "reason": f"browser-use agent error: {type(exc).__name__}: {exc}"})
        return None

    # Extract final text answer — shape varies across browser-use versions.
    text = None
    for attr in ("final_result", "final_text", "output", "result"):
        val = getattr(result, attr, None)
        if isinstance(val, str) and val.strip():
            text = val
            break
        if callable(val):
            try:
                maybe = val()
                if isinstance(maybe, str) and maybe.strip():
                    text = maybe
                    break
            except Exception:
                pass
    if text is None:
        text = str(result)

    parsed = _extract_json(text)
    if parsed is None:
        _emit({"type": "progress", "message": "agent returned no parseable JSON — emitting empty artifact"})
        return dict(_ARTIFACT_TEMPLATE)
    return _normalize_artifact(parsed)


def main():
    target_url = os.environ.get("HEALIX_TARGET_URL")
    if not target_url:
        _emit({"type": "error", "reason": "HEALIX_TARGET_URL not set"})
        sys.exit(2)

    # Dependency check up-front so the Node driver can degrade cleanly.
    try:
        import browser_use  # noqa: F401
    except ImportError as exc:
        _emit({
            "type": "error",
            "reason": f"browser-use not installed: {exc}. Install with: pipx install browser-use",
        })
        sys.exit(2)

    has_browser_use_key = os.environ.get("BROWSER_USE_API_KEY") or os.environ.get("HEALIX_BROWSER_USE_API_KEY")
    has_healix_proxy = os.environ.get("HEALIX_API_KEY") and os.environ.get("HEALIX_LLM_PROXY_URL")
    if not has_browser_use_key and not has_healix_proxy:
        _emit({
            "type": "error",
            "reason": (
                "BROWSER_USE_API_KEY or HEALIX_API_KEY/HEALIX_LLM_PROXY_URL not set."
                " The Node driver sets these automatically from your MCP config."
                " The driver will fall back to heuristic Playwright exploration."
            ),
        })
        sys.exit(2)

    _emit({"type": "ready", "target": target_url})

    username = os.environ.get("HEALIX_LOGIN_USERNAME") or None
    password = os.environ.get("HEALIX_LOGIN_PASSWORD") or None
    timeout_s = float(os.environ.get("HEALIX_TOTAL_TIMEOUT_S", "180"))

    stop_event = threading.Event()
    hb_thread = threading.Thread(target=_heartbeat_loop, args=(stop_event,), daemon=True)
    hb_thread.start()

    artifact = None
    try:
        artifact = asyncio.run(_drive_agent(target_url, username, password, timeout_s))
    finally:
        stop_event.set()

    if artifact is None:
        sys.exit(1)

    _emit({"type": "artifact", "data": artifact})


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        _emit({"type": "error", "reason": "interrupted"})
        sys.exit(130)
    except Exception as exc:  # noqa: BLE001
        _emit({"type": "error", "reason": f"{type(exc).__name__}: {exc}"})
        sys.exit(1)
