"""Find the player's built assets from Vite's manifest.

`npm run build` (frontend/) writes hashed files and
app/static/player/.vite/manifest.json. Templates call `vite_assets()` to get
the entry script and its CSS. Returns None when the player hasn't been built
(e.g. running the Python tests), so pages can say so instead of crashing.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from flask import url_for

MANIFEST = Path(__file__).resolve().parent / "static" / "player" / ".vite" / "manifest.json"
ENTRY = "src/main.ts"

_cache: dict[str, Any] = {"mtime": None, "data": None}


def _manifest() -> dict[str, Any] | None:
    try:
        mtime = MANIFEST.stat().st_mtime
    except FileNotFoundError:
        return None
    if _cache["mtime"] != mtime:
        _cache.update(mtime=mtime, data=json.loads(MANIFEST.read_text()))
    return _cache["data"]


RECORDING_ENTRY = "src/recording.ts"


def _css(manifest: dict[str, Any], key: str, seen: set[str]) -> list[str]:
    """CSS of a chunk and the chunks it imports (shared CSS lands in a common chunk)."""
    if key in seen or key not in manifest:
        return []
    seen.add(key)
    chunk = manifest[key]
    out = list(chunk.get("css", []))
    for imported in chunk.get("imports", []):
        out += [c for c in _css(manifest, imported, seen) if c not in out]
    return out


def vite_assets(entry: str = ENTRY) -> dict[str, Any] | None:
    manifest = _manifest() or {}
    chunk = manifest.get(entry)
    if not chunk:
        return None
    asset = lambda name: url_for("static", filename=f"player/{name}")  # noqa: E731
    return {"js": asset(chunk["file"]), "css": [asset(c) for c in _css(manifest, entry, set())]}
