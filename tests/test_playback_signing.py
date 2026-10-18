"""Tests for Uplynk playback URL building and token signing."""

from __future__ import annotations

import hashlib
import hmac
from urllib.parse import parse_qsl, urlsplit

import pytest

from app.uplynk.playback import (
    PlaybackError,
    PlaybackTarget,
    fetch_preplay,
    manifest_base_url,
    preplay_base_url,
    sign_url,
)
from tests.conftest import FakeResponse, FakeSession

BASE = "https://content.uplynk.com"


def _expected_sig(url: str, key: str) -> str:
    query = urlsplit(url).query
    unsigned = query.rsplit("&sig=", 1)[0]
    return hmac.new(key.encode(), unsigned.encode(), hashlib.sha256).hexdigest()


@pytest.mark.parametrize(
    ("target", "manifest", "expected"),
    [
        (PlaybackTarget("c", content_id="abc"), "m3u8", f"{BASE}/channel/abc.m3u8"),
        (PlaybackTarget("c", content_id="abc"), "mpd", f"{BASE}/channel/abc.mpd"),
        (
            PlaybackTarget("c", external_id="my ch", owner_id="own"),
            "m3u8",
            f"{BASE}/channel/ext/own/my%20ch.m3u8",
        ),
        (PlaybackTarget("a", content_id="asset1"), "m3u8", f"{BASE}/asset1.m3u8"),
        (PlaybackTarget("e", content_id="ev1"), "mpd", f"{BASE}/event/ev1.mpd"),
    ],
)
def test_manifest_base_url(target, manifest, expected):
    assert manifest_base_url(BASE + "/", target, manifest) == expected


def test_preplay_base_url_channel_and_asset():
    assert (
        preplay_base_url(BASE, PlaybackTarget("c", content_id="abc"))
        == f"{BASE}/preplay/channel/abc.json"
    )
    assert (
        preplay_base_url(BASE, PlaybackTarget("a", external_id="x", owner_id="o"))
        == f"{BASE}/preplay/ext/o/x.json"
    )


def test_preplay_rejects_events():
    with pytest.raises(PlaybackError, match="channels and assets"):
        preplay_base_url(BASE, PlaybackTarget("e", content_id="ev1"))


def test_target_requires_exactly_one_id():
    with pytest.raises(PlaybackError):
        PlaybackTarget("c")
    with pytest.raises(PlaybackError):
        PlaybackTarget("c", content_id="a", external_id="b", owner_id="o")
    with pytest.raises(PlaybackError, match="owner"):
        PlaybackTarget("c", external_id="b")
    with pytest.raises(PlaybackError, match="content type"):
        PlaybackTarget("z", content_id="a")


def test_sign_url_param_order_and_signature():
    signed = sign_url(
        f"{BASE}/channel/abc.m3u8",
        PlaybackTarget("c", content_id="abc"),
        api_key="k3y",
        ttl_seconds=60,
        extra=[("delay", "10"), ("rays", "dcba")],
        now=1_700_000_000,
        rn="42",
    )
    query = urlsplit(signed.url).query
    assert query.startswith("tc=1&exp=1700000060&rn=42&ct=c&cid=abc&delay=10&rays=dcba&sig=")
    assert parse_qsl(query)[-1] == ("sig", _expected_sig(signed.url, "k3y"))
    assert signed.expires_at == 1_700_000_060


def test_sign_url_external_id_uses_eid_oid():
    signed = sign_url(
        f"{BASE}/channel/ext/own/x.m3u8",
        PlaybackTarget("c", external_id="x", owner_id="own"),
        api_key="k",
        ttl_seconds=60,
        now=0,
        rn="1",
    )
    keys = [k for k, _ in parse_qsl(urlsplit(signed.url).query)]
    assert keys == ["tc", "exp", "rn", "ct", "eid", "oid", "sig"]


def test_sign_url_matches_uplynk_reference_algorithm():
    """Same inputs as Uplynk's Python sample must yield the same signature."""
    from urllib.parse import urlencode

    reference_query = urlencode(
        dict(tc="1", exp=1_700_000_060, rn="42", ct="a", eid="ext", oid="own")
    )
    reference_sig = hmac.new(b"secret", reference_query.encode(), hashlib.sha256).hexdigest()
    signed = sign_url(
        f"{BASE}/ext/own/ext.m3u8",
        PlaybackTarget("a", external_id="ext", owner_id="own"),
        api_key="secret",
        ttl_seconds=60,
        now=1_700_000_000,
        rn="42",
    )
    assert signed.url.endswith(f"?{reference_query}&sig={reference_sig}")


@pytest.mark.parametrize("reserved", ["sig", "exp", "cid", "tc"])
def test_sign_url_rejects_reserved_params(reserved):
    with pytest.raises(PlaybackError, match="Reserved"):
        sign_url(
            f"{BASE}/channel/abc.m3u8",
            PlaybackTarget("c", content_id="abc"),
            api_key="k",
            ttl_seconds=60,
            extra=[(reserved, "x")],
        )


@pytest.mark.parametrize("ttl", [5, 8 * 24 * 3600])
def test_sign_url_rejects_out_of_range_ttl(ttl):
    with pytest.raises(PlaybackError, match="TTL"):
        sign_url(f"{BASE}/a.m3u8", PlaybackTarget("a", content_id="a"), "k", ttl)


def test_sign_url_requires_api_key():
    with pytest.raises(PlaybackError, match="API key"):
        sign_url(f"{BASE}/a.m3u8", PlaybackTarget("a", content_id="a"), "", 60)


def test_fetch_preplay_parses_response():
    payload = {
        "playURL": "https://content-ause3.uplynk.com/preplay2/channel/abc/x.mpd?pbs=1",
        "prefix": "https://content-ause3.uplynk.com",
        "sid": "sess1",
        "drm": {"required": True, "widevineLicenseURL": "https://content-ause3.uplynk.com/wv"},
    }
    session = FakeSession(FakeResponse(200, payload))
    result = fetch_preplay("https://signed/url", session=session)
    assert result.play_url == payload["playURL"]
    assert result.prefix == payload["prefix"]
    assert result.drm["widevineLicenseURL"].endswith("/wv")
    assert session.calls[0][0] == "https://signed/url"


@pytest.mark.parametrize(
    ("response", "match"),
    [
        (FakeResponse(403, text="forbidden"), "HTTP 403"),
        (FakeResponse(200, None, text="<html>"), "non-JSON"),
        (FakeResponse(200, {"error": "token expired"}), "token expired"),
    ],
)
def test_fetch_preplay_errors(response, match):
    with pytest.raises(PlaybackError, match=match):
        fetch_preplay("https://signed/url", session=FakeSession(response))
