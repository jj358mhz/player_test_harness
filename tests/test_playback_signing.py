"""Tests for Uplynk playback URL building and token signing."""

from __future__ import annotations

import hashlib
import hmac
from urllib.parse import parse_qsl, urlsplit

import pytest
import requests

from app.uplynk.playback import (
    PlaybackError,
    PlaybackTarget,
    classify_hls_encryption,
    fetch_preplay,
    first_variant_url,
    manifest_base_url,
    preplay_base_url,
    probe_manifest,
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


def test_fetch_preplay_server_error_is_readable_and_names_ad_params():
    response = FakeResponse(500, text="<html><body>Server error, sorry</body></html>")
    url = "https://x.example.com/preplay/channel/chan0001.json?tc=1&ad=fw2&ad.lib=KOR&ad.preroll=1&sig=ab"
    with pytest.raises(PlaybackError) as e:
        fetch_preplay(url, session=FakeSession(response))
    message = str(e.value)
    assert message.startswith("Preplay returned HTTP 500: Server error, sorry. Ad params")
    assert "(ad.lib, ad.preroll)" in message and "<html>" not in message
    # No ad params, or a 4xx: just Uplynk's answer.
    with pytest.raises(PlaybackError) as e:
        fetch_preplay("https://x.example.com/p.json?tc=1&ad=fw2", session=FakeSession(response))
    assert str(e.value) == "Preplay returned HTTP 500: Server error, sorry"


@pytest.mark.parametrize(
    "body", ["#EXTM3U\n#EXT-X-VERSION:5\n", '<?xml version="1.0"?><MPD/>', "<MPD xmlns='x'/>"]
)
def test_probe_manifest_ok(body):
    result = probe_manifest("https://u", session=FakeSession(FakeResponse(200, text=body)))
    assert result.ok and result.status == 200 and result.error is None


@pytest.mark.parametrize(
    ("response", "status", "match"),
    [
        (
            FakeResponse(400, text="<html><body>Non dash asset 0123abcd</body></html>"),
            400,
            "HTTP 400: Non dash asset 0123abcd",
        ),
        (FakeResponse(403, text=""), 403, "HTTP 403: response is not a manifest"),
        (FakeResponse(200, text="<html>login</html>"), 200, "HTTP 200: login"),
        (requests.ConnectionError("down"), None, "Request failed: down"),
    ],
)
def test_probe_manifest_failures(response, status, match):
    result = probe_manifest("https://u", session=FakeSession(response))
    assert not result.ok
    assert result.status == status
    assert result.error == match


FAIRPLAY = (
    '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k.example/fp-spc/abc",'
    'KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"\n#EXTINF:4,\nFP_E0001.ts\n'
)
AES = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://k.example/key?r=e"\n#EXTINF:4,\ne1.ts\n'
CLEAR = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\ne1.ts\n"
# Live windows as Uplynk writes them: #UPLYNK-SEGMENT <asset>,<slice>,<kind>.
AD_KEY = '#EXT-X-KEY:METHOD=AES-128,URI="https://k.example/check2?x"\n'
FP_KEY = '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k.example/fp-spc/abc"\n'
AD_BREAK = f"#EXTM3U\n#UPLYNK-SEGMENT:ad0001,00000001,ad\n{AD_KEY}#EXTINF:4,\na1.ts\n"
AD_THEN_FAIRPLAY = (
    AD_BREAK + f"#UPLYNK-SEGMENT:asset0001,000000a0,segment\n{FP_KEY}#EXTINF:4,\nFP_E1.ts\n"
)
AD_THEN_AES = AD_BREAK + f"#UPLYNK-SEGMENT:asset0001,000000a0,segment\n{AD_KEY}#EXTINF:4,\ne1.ts\n"
MASTER = (
    "#EXTM3U\n#UPLYNK-MEDIA0:416x234x30,baseline-13,2x48000\n"
    "#EXT-X-STREAM-INF:BANDWIDTH=300000\nchannel/chan0001/a.m3u8?pbs=x\n"
    "#EXT-X-STREAM-INF:BANDWIDTH=900000\nchannel/chan0001/c.m3u8?pbs=x\n"
)


@pytest.mark.parametrize(
    ("playlist", "expected"),
    [
        (FAIRPLAY, "drm"),
        (AES, "aes-128"),
        ('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://k.example/k"\n', "sample-aes"),
        ("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n", "none"),
        (CLEAR, "none"),
        # An ad break is AES-128 even on Studio DRM channels: no verdict.
        (AD_BREAK, None),
        (AD_THEN_FAIRPLAY, "drm"),
        (AD_THEN_AES, "aes-128"),
    ],
)
def test_classify_hls_encryption(playlist, expected):
    assert classify_hls_encryption(playlist) == expected


def test_first_variant_url_resolves_relative():
    url = first_variant_url(MASTER, "https://content.example.com/channel/chan0001.m3u8?tc=1")
    assert url == "https://content.example.com/channel/channel/chan0001/a.m3u8?pbs=x"
    assert first_variant_url(CLEAR, "https://u") is None


@pytest.mark.parametrize(
    ("media", "expected"), [(FAIRPLAY, "drm"), (AES, "aes-128"), (CLEAR, "none")]
)
def test_probe_follows_first_variant_for_encryption(media, expected):
    key = FakeResponse(200, text="k" * 16)  # AES-128: the content key is fetched once
    session = FakeSession([FakeResponse(200, text=MASTER), FakeResponse(200, text=media), key])
    result = probe_manifest("https://content.example.com/x.m3u8", session=session)
    assert result.ok and result.encryption == expected
    assert session.calls[1][0].endswith("/a.m3u8?pbs=x")
    assert result.as_dict()["encryption"] == expected


def test_probe_encryption_unknown_when_variant_fails():
    session = FakeSession([FakeResponse(200, text=MASTER), FakeResponse(404, text="gone")])
    result = probe_manifest("https://u/x.m3u8", session=session)
    assert result.ok and result.encryption is None


def test_probe_dash_has_no_encryption_verdict():
    session = FakeSession(FakeResponse(200, text="<MPD/>"))
    result = probe_manifest("https://u/x.mpd", session=session)
    assert result.ok and result.encryption is None and len(session.calls) == 1


DRM_REFUSED = FakeResponse(400, text="<html><body>DRM disallows raw key request</body></html>")


@pytest.mark.parametrize(
    ("key", "expected"),
    [
        (DRM_REFUSED, "drm"),
        (FakeResponse(200, text="k" * 16), "aes-128"),
        (FakeResponse(403, text="nope"), "aes-128"),
        (requests.ConnectionError("down"), "aes-128"),
    ],
)
def test_probe_asks_for_a_content_key(key, expected):
    # Studio DRM channels can list AES-128 keys; only the key server tells.
    session = FakeSession(
        [FakeResponse(200, text=MASTER), FakeResponse(200, text=AD_THEN_AES), key]
    )
    result = probe_manifest("https://content.example.com/x.m3u8", session=session)
    assert result.encryption == expected
    # The content segment's key, not the ad's.
    assert session.calls[2][0] == "https://k.example/check2?x"


def test_content_key_uri_skips_ads():
    from app.uplynk.playback import content_key_uri

    assert content_key_uri(AD_BREAK) is None
    assert content_key_uri(AD_THEN_FAIRPLAY) is None  # not AES-128
    content = (
        AD_BREAK
        + '#UPLYNK-SEGMENT:a1,a0,segment\n#EXT-X-KEY:METHOD=AES-128,URI="https://k.example/c"\n#EXTINF:4,\ne1.ts\n'
    )
    assert content_key_uri(content) == "https://k.example/c"


def test_probe_ad_break_fetches_no_key():
    session = FakeSession([FakeResponse(200, text=MASTER), FakeResponse(200, text=AD_BREAK)])
    result = probe_manifest("https://content.example.com/x.m3u8", session=session)
    assert result.encryption is None and len(session.calls) == 2
