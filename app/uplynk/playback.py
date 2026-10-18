"""Build and sign Uplynk playback URLs, and call Preplay v2.

Signing: https://docs.uplynk.com/docs/sign-playback-urls-with-a-token
The token is HMAC-SHA256 (keyed with the account API key) over the URL-encoded
query string, in the order the params appear, with `sig` appended last. Every
param in the query — core and customization (rays, delay, rmt, manifest, ...)
— is part of the signed string.

Preplay v2: https://docs.uplynk.com/reference/preplay-v2
Returns an absolute `playURL`, zone `prefix`, and DRM license/certificate URLs.
"""

from __future__ import annotations

import hashlib
import hmac
import random
import re
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote, urlencode, urljoin

import requests

# ct values from the token spec.
CONTENT_TYPES = {
    "a": "asset",
    "c": "channel",
    "e": "event",
    "p": "playlist",
}
MANIFESTS = ("m3u8", "mpd")
# Preplay `rmt` values. FairPlay pairs with HLS; Widevine/PlayReady with DASH.
DRM_TYPES = {"fps": "m3u8", "wv": "mpd", "pr": "mpd"}
# Core token params we generate — callers can't override these via `extra`.
RESERVED_PARAMS = frozenset({"tc", "exp", "rn", "ct", "cid", "eid", "oid", "sig"})
MIN_TTL_SECONDS = 10
MAX_TTL_SECONDS = 7 * 24 * 3600


class PlaybackError(ValueError):
    """Raised for invalid playback requests or Preplay failures."""


@dataclass(frozen=True)
class PlaybackTarget:
    """What to play.

    Use either `content_id` (system GUID) or `external_id` (+ owner_id).
    """

    content_type: str  # a | c | e | p
    content_id: str | None = None
    external_id: str | None = None
    owner_id: str | None = None

    def __post_init__(self) -> None:
        if self.content_type not in CONTENT_TYPES:
            raise PlaybackError(f"Unknown content type {self.content_type!r}")
        if bool(self.content_id) == bool(self.external_id):
            raise PlaybackError("Provide exactly one of content_id or external_id")
        if self.external_id and not self.owner_id:
            raise PlaybackError("external_id playback needs the workspace (owner) ID")

    @property
    def path_id(self) -> str:
        """Path segment identifying the content, without extension."""
        if self.content_id:
            return quote(self.content_id, safe="")
        return f"ext/{quote(self.owner_id, safe='')}/{quote(self.external_id, safe='')}"


@dataclass
class SignedPlayback:
    url: str
    base_url: str
    params: list[tuple[str, str]]  # signed params, excluding sig
    expires_at: int


@dataclass
class PreplayResult:
    play_url: str
    prefix: str | None
    sid: str | None
    drm: dict[str, Any] | None
    raw: dict[str, Any] = field(repr=False)


def manifest_base_url(content_base: str, target: PlaybackTarget, manifest: str) -> str:
    if manifest not in MANIFESTS:
        raise PlaybackError(f"Unknown manifest type {manifest!r}")
    base = content_base.rstrip("/")
    prefix = {"a": "", "c": "channel/", "e": "event/", "p": "playlist/"}[target.content_type]
    return f"{base}/{prefix}{target.path_id}.{manifest}"


def preplay_base_url(content_base: str, target: PlaybackTarget) -> str:
    base = content_base.rstrip("/")
    if target.content_type == "c":
        return f"{base}/preplay/channel/{target.path_id}.json"
    if target.content_type == "a":
        return f"{base}/preplay/{target.path_id}.json"
    raise PlaybackError("Preplay v2 supports channels and assets only")


def sign_url(
    base_url: str,
    target: PlaybackTarget,
    api_key: str,
    ttl_seconds: int,
    extra: list[tuple[str, str]] | None = None,
    now: int | None = None,
    rn: str | None = None,
) -> SignedPlayback:
    """Append a signed token to `base_url`."""
    if not api_key:
        raise PlaybackError("Account has no API key to sign with")
    if not MIN_TTL_SECONDS <= ttl_seconds <= MAX_TTL_SECONDS:
        raise PlaybackError(f"Token TTL must be between {MIN_TTL_SECONDS}s and {MAX_TTL_SECONDS}s")
    extra = list(extra or [])
    clashes = sorted({k for k, _ in extra} & RESERVED_PARAMS)
    if clashes:
        raise PlaybackError(f"Reserved token params can't be overridden: {', '.join(clashes)}")

    now = int(time.time()) if now is None else now
    expires_at = now + ttl_seconds
    params: list[tuple[str, str]] = [
        ("tc", "1"),
        ("exp", str(expires_at)),
        ("rn", rn if rn is not None else str(random.randint(0, 2**32))),
        ("ct", target.content_type),
    ]
    if target.content_id:
        params.append(("cid", target.content_id))
    else:
        params += [("eid", target.external_id), ("oid", target.owner_id)]
    params += [(str(k), str(v)) for k, v in extra]

    query = urlencode(params)
    sig = hmac.new(api_key.encode(), query.encode(), hashlib.sha256).hexdigest()
    return SignedPlayback(
        url=f"{base_url}?{query}&sig={sig}",
        base_url=base_url,
        params=params,
        expires_at=expires_at,
    )


def fetch_preplay(
    signed_url: str,
    timeout: int = 15,
    session: requests.Session | None = None,
) -> PreplayResult:
    """GET a signed Preplay v2 URL and parse the response."""
    http = session or requests
    try:
        response = http.get(signed_url, timeout=timeout, headers={"Accept": "application/json"})
    except requests.RequestException as e:
        raise PlaybackError(f"Preplay request failed: {e}") from e
    if response.status_code != 200:
        raise PlaybackError(f"Preplay returned HTTP {response.status_code}: {response.text[:200]}")
    try:
        payload = response.json()
    except ValueError as e:
        raise PlaybackError("Preplay returned non-JSON response") from e
    if not payload.get("playURL"):
        detail = payload.get("error") or payload.get("msg") or "no playURL in response"
        raise PlaybackError(f"Preplay failed: {detail}")
    return PreplayResult(
        play_url=payload["playURL"],
        prefix=payload.get("prefix"),
        sid=payload.get("sid"),
        drm=payload.get("drm"),
        raw=payload,
    )


@dataclass
class ProbeResult:
    """What Uplynk answered when we fetched a signed manifest once."""

    ok: bool
    status: int | None
    error: str | None
    elapsed_ms: int
    # HLS only: see classify_hls_encryption. None when not determined.
    encryption: str | None = None
    # The manifest served (never sent to the browser: it carries session tokens).
    body: str | None = field(default=None, repr=False)
    fetched_at: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "status": self.status,
            "error": self.error,
            "elapsed_ms": self.elapsed_ms,
            "encryption": self.encryption,
        }


_MANIFEST_MARKERS = ("#EXTM3U", "<MPD", "<?xml")


def probe_manifest(
    url: str,
    timeout: int = 8,
    session: requests.Session | None = None,
) -> ProbeResult:
    """GET a signed manifest and report whether Uplynk served one.

    Uplynk explains most failures in a short HTML body (``Non dash asset
    <id>``, ``Invalid signature``…), so that text becomes the error.
    """
    http = session or requests
    start = time.monotonic()
    try:
        response = http.get(url, timeout=timeout)
    except requests.RequestException as e:
        return ProbeResult(False, None, f"Request failed: {e}", _ms_since(start))
    elapsed = _ms_since(start)
    fetched_at = time.time()
    body = response.text or ""
    if response.status_code == 200 and body.lstrip().startswith(_MANIFEST_MARKERS):
        encryption = None
        if body.lstrip().startswith("#EXTM3U"):
            encryption = _hls_encryption(body, url, timeout, http)
        return ProbeResult(True, 200, None, elapsed, encryption, body, fetched_at)
    detail = _strip_html(body) or "response is not a manifest"
    return ProbeResult(
        False, response.status_code, f"HTTP {response.status_code}: {detail}", elapsed
    )


def classify_hls_encryption(playlist: str) -> str:
    """How an HLS media playlist is protected.

    - ``drm``: Studio DRM. Uplynk's HLS flavour is FairPlay
      (``KEYFORMAT="com.apple.streamingkeydelivery"``, ``skd://`` keys).
    - ``aes-128``: clear-key AES-128 (``METHOD=AES-128``).
    - ``sample-aes``: SAMPLE-AES without FairPlay keys.
    - ``none``: no ``EXT-X-KEY`` (or ``METHOD=NONE``).
    """
    keys = [line for line in playlist.splitlines() if line.startswith("#EXT-X-KEY")]
    if any("com.apple.streamingkeydelivery" in k or "skd://" in k for k in keys):
        return "drm"
    if any("METHOD=AES-128" in k for k in keys):
        return "aes-128"
    if any("METHOD=SAMPLE-AES" in k for k in keys):
        return "sample-aes"
    return "none"


def first_variant_url(master: str, base_url: str) -> str | None:
    """Absolute URL of the first variant in an HLS master playlist."""
    lines = [line.strip() for line in master.splitlines()]
    for i, line in enumerate(lines):
        if line.startswith("#EXT-X-STREAM-INF"):
            for uri in lines[i + 1 :]:
                if uri and not uri.startswith("#"):
                    return urljoin(base_url, uri)
    return None


def _hls_encryption(body: str, url: str, timeout: int, http: Any) -> str | None:
    """Keys only appear in media playlists, so follow the first variant."""
    media = _media_playlist(body, url, timeout, http)
    return None if media is None else classify_hls_encryption(media)


def fetch_media_playlist(
    url: str, timeout: int = 8, session: requests.Session | None = None
) -> str | None:
    """Text of the first media playlist behind a signed HLS URL, or None."""
    http = session or requests
    try:
        response = http.get(url, timeout=timeout)
    except requests.RequestException:
        return None
    if response.status_code != 200 or not (response.text or "").lstrip().startswith("#EXTM3U"):
        return None
    return _media_playlist(response.text, url, timeout, http)


def _media_playlist(body: str, url: str, timeout: int, http: Any) -> str | None:
    if "#EXT-X-STREAM-INF" not in body:
        return body
    variant = first_variant_url(body, url)
    if variant is None:
        return None
    try:
        response = http.get(variant, timeout=timeout)
    except requests.RequestException:
        return None
    if response.status_code != 200 or not (response.text or "").lstrip().startswith("#EXTM3U"):
        return None
    return response.text


def _ms_since(start: float) -> int:
    return int((time.monotonic() - start) * 1000)


def _strip_html(text: str, limit: int = 300) -> str:
    plain = re.sub(r"<[^>]+>", " ", text)
    return " ".join(plain.split())[:limit]
