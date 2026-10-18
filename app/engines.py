"""Player engine versions offered in the player's version menu.

The menu shows the latest patch of the last few minor lines of each engine,
read from the npm registry and cached in-process. Pre-releases are skipped.
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass
from typing import Any

import requests

# package → GitHub repo for release-notes links
ENGINES: dict[str, str] = {
    "hls.js": "video-dev/hls.js",
    "shaka-player": "shaka-project/shaka-player",
}

NPM_REGISTRY = "https://registry.npmjs.org"
CACHE_SECONDS = 24 * 3600
MINOR_LINES = 3

_STABLE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_lock = threading.Lock()


class EngineVersionsError(RuntimeError):
    pass


@dataclass(frozen=True)
class Release:
    version: str
    released: str | None  # ISO date

    @property
    def key(self) -> tuple[int, int, int]:
        major, minor, patch = (int(p) for p in self.version.split("."))
        return major, minor, patch


def latest_patch_per_minor(releases: list[Release], lines: int = MINOR_LINES) -> list[Release]:
    """Newest first: the highest patch of each of the newest `lines` minors."""
    best: dict[tuple[int, int], Release] = {}
    for r in releases:
        major, minor, _ = r.key
        current = best.get((major, minor))
        if current is None or r.key > current.key:
            best[(major, minor)] = r
    return sorted(best.values(), key=lambda r: r.key, reverse=True)[:lines]


def parse_registry(payload: dict[str, Any]) -> list[Release]:
    times = payload.get("time") or {}
    versions = payload.get("versions") or {}
    return [
        Release(v, (times.get(v) or "")[:10] or None)
        for v in versions
        if _STABLE.match(v) and not versions[v].get("deprecated")
    ]


def engine_versions(
    package: str, session: requests.Session | None = None, now: float | None = None
) -> list[dict[str, Any]]:
    """Cached menu entries for `package`. Raises EngineVersionsError."""
    if package not in ENGINES:
        raise EngineVersionsError(f"Unknown engine {package!r}")
    now = time.time() if now is None else now
    with _lock:
        cached = _cache.get(package)
        if cached and now - cached[0] < CACHE_SECONDS:
            return cached[1]

    http = session or requests
    try:
        response = http.get(f"{NPM_REGISTRY}/{package}", timeout=10)
        response.raise_for_status()
        releases = parse_registry(response.json())
    except (requests.RequestException, ValueError) as e:
        if cached:  # serve stale rather than nothing
            return cached[1]
        raise EngineVersionsError(f"Could not read {package} versions from npm: {e}") from e

    repo = ENGINES[package]
    entries = [
        {
            "version": r.version,
            "released": r.released,
            "notes_url": f"https://github.com/{repo}/releases/tag/v{r.version}",
        }
        for r in latest_patch_per_minor(releases)
    ]
    with _lock:
        _cache[package] = (now, entries)
    return entries


def clear_cache() -> None:
    with _lock:
        _cache.clear()
