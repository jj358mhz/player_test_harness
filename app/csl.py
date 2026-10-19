"""Slicer facts from csl-slicer-console (its `/api/slicers/<id>/settings`).

Server to server with a shared bearer token (`CSL_API_TOKEN`, the
console's `PLAYER_API_TOKEN`), so the browser never sees it. The console
only knows its own cloud slicers; on-prem slicers come back as unknown.
"""

from __future__ import annotations

import threading
import time
from typing import Any
from urllib.parse import quote

import requests
from flask import current_app

TIMEOUT_S = 5
# A slicer's config changes only when it restarts; a few minutes is fresh enough.
CACHE_TTL_S = 300

_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_lock = threading.Lock()


def enabled() -> bool:
    return bool(current_app.config["CSL_API_URL"] and current_app.config["CSL_API_TOKEN"])


def slicer_settings(slicer_id: str) -> dict[str, Any]:
    """`{wallclock: bool|None, captured_at, running, found, error}` for a slicer."""
    now = time.monotonic()
    with _lock:
        hit = _cache.get(slicer_id)
        if hit and now - hit[0] < CACHE_TTL_S:
            return hit[1]
    result = _fetch(slicer_id)
    if result["error"] is None:  # retry failures on the next ask
        with _lock:
            _cache[slicer_id] = (now, result)
    return result


def _fetch(slicer_id: str) -> dict[str, Any]:
    base = current_app.config["CSL_API_URL"]
    url = f"{base}/api/slicers/{quote(slicer_id, safe='')}/settings"
    unknown = {"found": False, "wallclock": None, "captured_at": None, "running": None}
    try:
        response = requests.get(
            url,
            headers={"Authorization": f"Bearer {current_app.config['CSL_API_TOKEN']}"},
            timeout=TIMEOUT_S,
        )
    except requests.RequestException as e:
        return {**unknown, "error": f"slicer console unreachable: {type(e).__name__}"}
    if response.status_code == 404:
        # The API answers an unknown slicer (e.g. on-prem) with a JSON error;
        # a plain 404 page means the route is off (PLAYER_API_TOKEN unset) or missing.
        try:
            body = response.json()
        except ValueError:
            body = None
        if isinstance(body, dict) and body.get("error"):
            return {**unknown, "error": None}
        return {
            **unknown,
            "error": "slicer console API is off (PLAYER_API_TOKEN unset, or console < v1.17.0)",
        }
    if response.status_code == 401:
        return {**unknown, "error": "slicer console rejected CSL_API_TOKEN"}
    if response.status_code >= 400:
        return {**unknown, "error": f"slicer console answered {response.status_code}"}
    try:
        body = response.json()
    except ValueError:
        return {**unknown, "error": "slicer console sent no JSON"}
    wallclock = body.get("wallclock")
    return {
        "found": True,
        "wallclock": wallclock if isinstance(wallclock, bool) else None,
        "captured_at": body.get("captured_at"),
        "running": body.get("running"),
        "error": None,
    }


def clear_cache() -> None:
    with _lock:
        _cache.clear()
