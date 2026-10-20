"""Playback service: resolve an account, sign or Preplay, and audit it."""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from flask import current_app
from flask_login import current_user

from app.crypto import decrypt
from app.models import Channel, ChannelHealthCheck, PlaybackEvent, UplynkAccount, db
from app.uplynk.clock import dash_clock
from app.uplynk.health import Health, assess
from app.uplynk.playback import (
    DRM_TYPES,
    MANIFESTS,
    PlaybackError,
    PlaybackTarget,
    ProbeResult,
    fetch_media_playlist,
    fetch_preplay,
    manifest_base_url,
    preplay_base_url,
    probe_manifest,
    sign_url,
)


@dataclass(frozen=True)
class PlaybackRequest:
    account: UplynkAccount
    target: PlaybackTarget
    manifest: str = "m3u8"
    mode: str = "url"  # url | preplay
    drm: str | None = None  # fps | wv | pr
    ttl_seconds: int | None = None
    extra: tuple[tuple[str, str], ...] = ()
    channel: Channel | None = None
    probe: bool = True  # fetch the manifest once and report Uplynk's answer


def parse_request(data: dict[str, Any]) -> PlaybackRequest:
    """Validate a JSON body from POST /api/playback."""
    channel = None
    if data.get("channel_id") is not None:
        channel = db.session.get(Channel, _int(data["channel_id"], "channel_id"))
        if channel is None:
            raise PlaybackError("Unknown channel")
        account = channel.uplynk_account
        target = PlaybackTarget(content_type="c", content_id=channel.channel_id)
    else:
        account = db.session.get(UplynkAccount, _int(data.get("account_id"), "account_id"))
        if account is None:
            raise PlaybackError("Unknown account")
        external_id = (data.get("external_id") or "").strip() or None
        target = PlaybackTarget(
            content_type=data.get("content_type", "c"),
            content_id=(data.get("content_id") or "").strip() or None,
            external_id=external_id,
            owner_id=account.workspace_id if external_id else None,
        )

    mode = data.get("mode", "url")
    if mode not in ("url", "preplay"):
        raise PlaybackError(f"Unknown mode {mode!r}")
    drm = data.get("drm") or None
    if drm is not None and drm not in DRM_TYPES:
        raise PlaybackError(f"Unknown DRM type {drm!r}")
    manifest = data.get("manifest") or (DRM_TYPES[drm] if drm else "m3u8")
    if manifest not in MANIFESTS:
        raise PlaybackError(f"Unknown manifest type {manifest!r}")
    if drm and DRM_TYPES[drm] != manifest:
        raise PlaybackError(f"DRM {drm!r} requires the {DRM_TYPES[drm]} manifest")
    if drm and mode != "preplay":
        raise PlaybackError("DRM playback needs Preplay mode to get license URLs")

    ttl = data.get("ttl_seconds")
    raw_params = data.get("params") or {}
    if not isinstance(raw_params, dict):
        raise PlaybackError("params must be an object of string values")
    extra = tuple((str(k), str(v)) for k, v in raw_params.items() if str(k).strip())

    return PlaybackRequest(
        account=account,
        target=target,
        manifest=manifest,
        mode=mode,
        drm=drm,
        ttl_seconds=_int(ttl, "ttl_seconds") if ttl not in (None, "") else None,
        extra=extra,
        channel=channel,
        probe=bool(data.get("probe", True)),
    )


def create_playback(req: PlaybackRequest) -> dict[str, Any]:
    """Sign (and optionally Preplay) a playback request. Always audits."""
    content_base = current_app.config["UPLYNK_CONTENT_BASE"]
    ttl = req.ttl_seconds or current_app.config["PLAYBACK_TOKEN_TTL"]
    extra = list(req.extra)
    api_key = decrypt(req.account.api_key_encrypted)
    if req.mode == "preplay":
        base_url = preplay_base_url(content_base, req.target)
        extra.append(("manifest", req.manifest))
        if req.drm:
            extra.append(("rmt", req.drm))
    else:
        base_url = manifest_base_url(content_base, req.target, req.manifest)

    event = PlaybackEvent(
        user_id=current_user.id if current_user.is_authenticated else None,
        uplynk_account_id=req.account.id,
        channel_id=req.channel.id if req.channel else None,
        mode=req.mode,
        content_type=req.target.content_type,
        content_id=req.target.content_id or req.target.external_id,
        manifest=req.manifest,
        drm=req.drm,
        base_url=base_url,
        params=dict(extra) or None,
    )
    db.session.add(event)

    try:
        signed = sign_url(base_url, req.target, api_key, ttl, extra)
        event.expires_at = datetime.fromtimestamp(signed.expires_at, UTC)
        result: dict[str, Any] = {
            "mode": req.mode,
            "manifest": req.manifest,
            "drm": req.drm,
            "expires_at": event.expires_at.isoformat(),
        }
        if req.mode == "preplay":
            preplay = fetch_preplay(signed.url)
            event.status_code = 200
            if req.channel and (preplay.drm or {}).get("required"):
                record_encryption(req.channel, "drm")
            result.update(
                url=preplay.play_url,
                prefix=preplay.prefix,
                sid=preplay.sid,
                drm_config=preplay.drm,
            )
        else:
            result["url"] = signed.url
    except PlaybackError as e:
        event.error = str(e)
        db.session.commit()
        raise

    if req.probe:
        # A signed URL can still fail (content not packaged for DASH, token
        # rejected...). Report Uplynk's answer rather than leaving the user
        # with a silent failed download.
        probe = probe_manifest(result["url"])
        event.status_code = probe.status
        event.error = probe.error
        if req.channel and probe.encryption:
            record_encryption(req.channel, probe.encryption)
        result["probe"] = probe.as_dict()
        if req.manifest == "mpd" and probe.ok and probe.body:
            result["clock"] = measure_dash_clock(req, probe, api_key)
    db.session.commit()
    result["event_id"] = event.id
    return result


def measure_dash_clock(req: PlaybackRequest, probe: ProbeResult, api_key: str) -> dict | None:
    """How far this MPD's clock runs ahead of the encoder's (see app/uplynk/clock.py).

    Signs the same content as HLS with `pdts=latency` (and the same `delay`,
    so the windows overlap) and matches slices. Not audited: it's a
    measurement, not playback. None for VOD or when nothing matches.
    """
    if 'type="dynamic"' not in probe.body:
        return None
    content_base = current_app.config["UPLYNK_CONTENT_BASE"]
    params = [("pdts", "latency")] + [(k, v) for k, v in req.extra if k == "delay"]
    base_url = manifest_base_url(content_base, req.target, "m3u8")
    ttl = current_app.config["PLAYBACK_TOKEN_TTL"]
    reference = fetch_media_playlist(sign_url(base_url, req.target, api_key, ttl, params).url)
    if reference is None:
        return None
    clock = dash_clock(probe.body, reference, probe.fetched_at)
    return clock.as_dict() if clock else None


def record_encryption(channel: Channel, encryption: str) -> None:
    """Remember how a channel is protected, for the dashboard badge."""
    channel.encryption = encryption
    channel.encryption_checked_at = datetime.now(UTC)


def check_encryption(
    channels: list[Channel], workers: int = 4
) -> list[tuple[Channel, ProbeResult]]:
    """Sign HLS for each channel, probe it, and record its encryption.

    URLs are signed up front (signing needs the app context); only the
    HTTP probes run in the thread pool. Not audited as playback events.
    """
    content_base = current_app.config["UPLYNK_CONTENT_BASE"]
    ttl = current_app.config["PLAYBACK_TOKEN_TTL"]
    keys: dict[int, str] = {}
    urls = []
    for channel in channels:
        account = channel.uplynk_account
        if account.id not in keys:
            keys[account.id] = decrypt(account.api_key_encrypted)
        target = PlaybackTarget(content_type="c", content_id=channel.channel_id)
        base_url = manifest_base_url(content_base, target, "m3u8")
        urls.append(sign_url(base_url, target, keys[account.id], ttl).url)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        probes = list(pool.map(probe_manifest, urls))
    for channel, probe in zip(channels, probes, strict=True):
        if probe.encryption:
            record_encryption(channel, probe.encryption)
    db.session.commit()
    return list(zip(channels, probes, strict=True))


def check_health(
    channels: list[Channel], workers: int = 6, now: float | None = None
) -> list[tuple[Channel, Health]]:
    """Probe each channel's `pdts=latency` HLS and record how old its live edge is.

    Also records encryption from the same probe. Like check_encryption:
    signs up front, probes in a pool, not audited as playback events.
    """
    content_base = current_app.config["UPLYNK_CONTENT_BASE"]
    ttl = current_app.config["PLAYBACK_TOKEN_TTL"]
    keys: dict[int, str] = {}
    urls = []
    for channel in channels:
        account = channel.uplynk_account
        if account.id not in keys:
            keys[account.id] = decrypt(account.api_key_encrypted)
        target = PlaybackTarget(content_type="c", content_id=channel.channel_id)
        base_url = manifest_base_url(content_base, target, "m3u8")
        signed = sign_url(base_url, target, keys[account.id], ttl, [("pdts", "latency")])
        urls.append(signed.url)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        probes = list(pool.map(probe_manifest, urls))
    checked_at = datetime.now(UTC)
    results = []
    for channel, probe in zip(channels, probes, strict=True):
        health = assess(probe.ok, probe.error, probe.media, now if now is not None else time.time())
        channel.health_status = health.status
        channel.health_edge_s = health.edge_age_s
        channel.health_detail = health.detail
        channel.health_checked_at = checked_at
        db.session.add(
            ChannelHealthCheck(
                channel_id=channel.id,
                checked_at=checked_at,
                status=health.status,
                edge_s=health.edge_age_s,
                detail=health.detail,
            )
        )
        if probe.encryption:
            record_encryption(channel, probe.encryption)
        results.append((channel, health))
    keep = timedelta(days=current_app.config["HEALTH_HISTORY_DAYS"])
    db.session.query(ChannelHealthCheck).filter(
        ChannelHealthCheck.checked_at < checked_at - keep
    ).delete(synchronize_session=False)
    db.session.commit()
    return results


def _int(value: Any, name: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError) as e:
        raise PlaybackError(f"{name} must be an integer") from e
