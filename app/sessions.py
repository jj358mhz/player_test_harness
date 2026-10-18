"""Recorded player sessions: validate, redact, store, prune.

The browser builds the recording (frontend/src/lib/recording.ts) and
redacts it; this redacts again, because nothing signed may be stored.
"""

from __future__ import annotations

import json
import re
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

from flask import current_app

from app.models import Channel, PlaybackSession, User, db

RECORDING_VERSION = 1
# sig= signs a URL; pbs= is a Preplay session token. Either would replay.
_TOKENS = re.compile(r"([?&](?:amp;)?(?:sig|pbs)=)[^&\s\"'<]+", re.IGNORECASE)
# ...and percent-encoded inside another URL (a `src=` deep link).
_ENCODED_TOKENS = re.compile(r"((?:%3F|%26)(?:sig|pbs)%3D)[^&%\s\"'<]+", re.IGNORECASE)
# Preplay play URLs carry the session in the path: /preplay2/channel/<id>/<sid>/<token>.mpd
_PREPLAY_PATH = re.compile(r"(/preplay2/(?:channel/|event/)?[^/?#\s\"'<]+/)[^?#\s\"'<]+")
# Keys whose values are license URLs: keep origin + path only.
_STRIP_QUERY_KEYS = {"licenseServer", "licenseUrl", "license_url"}


class RecordingError(ValueError):
    """The upload isn't a recording we can keep."""


def redact(value: Any, key: str | None = None) -> Any:
    if isinstance(value, str):
        if key in _STRIP_QUERY_KEYS and "?" in value:
            parts = urlsplit(value)
            value = f"{parts.scheme}://{parts.netloc}{parts.path}" if parts.netloc else ""
        for pattern in (_TOKENS, _ENCODED_TOKENS, _PREPLAY_PATH):
            value = pattern.sub(r"\1…", value)
        return value
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, dict):
        return {k: redact(v, k) for k, v in value.items()}
    return value


def _epoch_ms(value: Any, name: str) -> datetime:
    if not isinstance(value, int | float) or value <= 0:
        raise RecordingError(f"{name} must be a timestamp in milliseconds")
    return datetime.fromtimestamp(value / 1000, UTC)


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, int | float) else None


def _text(value: Any, limit: int, default: str = "") -> str:
    return str(value)[:limit] if isinstance(value, str) and value else default


def save_recording(data: Any, user: User | None) -> PlaybackSession:
    """Validate and store a recording; returns the new row (committed)."""
    if not isinstance(data, dict):
        raise RecordingError("Expected a JSON object")
    if data.get("v") != RECORDING_VERSION:
        raise RecordingError(f"Unsupported recording version {data.get('v')!r}")
    source = data.get("source")
    if not isinstance(source, dict):
        raise RecordingError("source is missing")
    for key in ("series", "stats", "counters"):
        if not isinstance(data.get(key), dict):
            raise RecordingError(f"{key} is missing")
    started = _epoch_ms(data.get("startedAt"), "startedAt")
    ended = _epoch_ms(data.get("endedAt"), "endedAt")
    if ended < started:
        raise RecordingError("endedAt is before startedAt")

    clean = redact(data)
    body = json.dumps(clean, separators=(",", ":"))
    limit = current_app.config["MAX_RECORDING_BYTES"]
    if len(body) > limit:
        raise RecordingError(
            f"Recording is {len(body) // 1024} KB; the limit is {limit // 1024} KB"
        )

    channel_id = source.get("channel")
    channel = db.session.get(Channel, channel_id) if isinstance(channel_id, int) else None
    latency = (clean.get("stats") or {}).get("latency") or {}
    counters = clean.get("counters") or {}
    row = PlaybackSession(
        slug=secrets.token_urlsafe(9),
        user_id=user.id if user else None,
        channel_id=channel.id if channel else None,
        title=_text(clean.get("title"), 255, "Untitled"),
        engine=_text(source.get("engine"), 40, "?"),
        engine_version=_text(source.get("version"), 40, "?"),
        manifest="mpd" if source.get("format") == "mpd" else "m3u8",
        drm=_text(source.get("drm"), 40) or None,
        live=bool(clean.get("live", True)),
        started_at=started,
        ended_at=ended,
        latency_name=_text(clean.get("latencyName"), 10) or None,
        latency_avg=_number(latency.get("avg")),
        latency_max=_number(latency.get("max")),
        rebuffers=int(_number(counters.get("rebuffers")) or 0),
        errors=int(_number(counters.get("errors")) or 0),
        size_bytes=len(body),
        data=body,
    )
    db.session.add(row)
    db.session.commit()
    prune_sessions()
    return row


def prune_sessions(days: int | None = None) -> int:
    """Delete sessions older than the retention setting; returns how many."""
    days = current_app.config["SESSION_RETENTION_DAYS"] if days is None else days
    if days <= 0:
        return 0
    cutoff = datetime.now(UTC) - timedelta(days=days)
    deleted = (
        db.session.query(PlaybackSession)
        .filter(PlaybackSession.created_at < cutoff)
        .delete(synchronize_session=False)
    )
    db.session.commit()
    return deleted


def expires_at(row: PlaybackSession) -> datetime | None:
    days = current_app.config["SESSION_RETENTION_DAYS"]
    if days <= 0:
        return None
    created = row.created_at
    if created.tzinfo is None:  # SQLite drops the zone
        created = created.replace(tzinfo=UTC)
    return created + timedelta(days=days)
