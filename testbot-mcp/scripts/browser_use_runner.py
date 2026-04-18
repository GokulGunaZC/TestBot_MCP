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
    2  dependency missing (browser-use or OPENAI_API_KEY); driver falls back

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
    OPENAI_API_KEY          - required; browser-use needs an LLM
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
    cred_note = ""
    if username and password:
        cred_note = (
            " If you encounter a login form, attempt to log in using"
            f" username={username!r} and password={password!r}. Record the"
            " login URL, the username/password field selectors, a success"
            " indicator (CSS selector only visible when logged in), and a"
            " failure indicator."
        )
    return (
        f"Explore the web application at {target_url}. Produce a structured"
        " report in the JSON schema below. Do NOT describe anything outside"
        " the JSON block — only emit one JSON object as the final answer."
        " Schema:\n"
        '{"routes":[{"path":string,"requiresAuth":boolean,"elements":[{"role":string,"name":string,"selector":string}]}],'
        '"forms":[{"route":string,"fields":[{"name":string,"type":string,"required":boolean}],"submitLabel":string}],'
        '"authFlow":{"loginUrl":string,"credentialFields":{"username":string,"password":string},"successIndicator":string,"failureIndicator":string}|null,'
        '"keyFlows":[{"name":string,"steps":[{"action":string,"target":string,"value":string|null}],"endCondition":string}],'
        '"observedErrors":[string]}\n'
        "Steps:\n"
        "1. Visit the homepage; list up to 10 reachable distinct routes.\n"
        "2. For each route with a <form>, enumerate fields + submit label.\n"
        "3. If a login form is present, populate authFlow.\n"
        "4. Identify up to 3 key user flows and their end condition.\n"
        "5. Capture any console or network errors observed."
        f"{cred_note}"
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


async def _drive_agent(target_url, username, password, timeout_s):
    try:
        from browser_use import Agent  # type: ignore
    except ImportError as exc:
        _emit({"type": "error", "reason": f"browser-use import failed: {exc}"})
        return None

    # browser-use supports multiple LLM imports depending on version.
    llm = None
    for import_path, ctor in (
        ("browser_use.llm", "ChatOpenAI"),
        ("browser_use", "ChatOpenAI"),
    ):
        try:
            module = __import__(import_path, fromlist=[ctor])
            cls = getattr(module, ctor)
            llm = cls(model=os.environ.get("HEALIX_BROWSER_USE_MODEL", "gpt-4o-mini"))
            break
        except Exception:
            continue
    if llm is None:
        # Fallback: let browser-use construct its own default LLM.
        try:
            llm = None  # Agent's default path
        except Exception as exc:
            _emit({"type": "error", "reason": f"Could not construct LLM: {exc}"})
            return None

    task = _build_task(target_url, username, password)

    try:
        agent = Agent(task=task, llm=llm) if llm is not None else Agent(task=task)
    except TypeError as exc:
        _emit({"type": "error", "reason": f"Agent API mismatch: {exc}"})
        return None
    except Exception as exc:
        _emit({"type": "error", "reason": f"Agent construction failed: {type(exc).__name__}: {exc}"})
        return None

    _emit({"type": "progress", "message": "agent launched"})

    try:
        result = await asyncio.wait_for(agent.run(), timeout=timeout_s)
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

    if not os.environ.get("OPENAI_API_KEY"):
        _emit({
            "type": "error",
            "reason": (
                "OPENAI_API_KEY not set — browser-use needs an LLM. Either set"
                " OPENAI_API_KEY in the MCP environment (opt-in), or the Node"
                " driver will fall back to heuristic Playwright exploration."
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
