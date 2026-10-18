"""Tests for POST /api/playback and the playback audit trail."""

from __future__ import annotations

from urllib.parse import parse_qsl, urlsplit

import pytest

from app.api import service
from app.models import PlaybackEvent, db
from app.uplynk.playback import PlaybackError, PreplayResult, ProbeResult


def _post(client, body):
    return client.post("/api/playback", json=body)


def test_requires_login(client):
    response = _post(client, {"channel_id": 1})
    assert response.status_code == 302


def test_sign_channel_hls(auth_client, make_account, make_channel):
    ch = make_channel(make_account(), "abc")
    response = _post(auth_client, {"channel_id": ch.id})
    assert response.status_code == 200
    data = response.get_json()
    parts = urlsplit(data["url"])
    assert parts.path == "/channel/abc.m3u8"
    params = dict(parse_qsl(parts.query))
    assert params["ct"] == "c" and params["cid"] == "abc" and "sig" in params
    assert data["mode"] == "url" and data["manifest"] == "m3u8"

    event = db.session.get(PlaybackEvent, data["event_id"])
    assert event.channel_id == ch.id
    assert event.error is None
    assert "sig" not in (event.params or {})
    assert "sig=" not in event.base_url


def test_sign_ad_hoc_external_id_with_params(auth_client, make_account):
    acct = make_account(workspace_id="own1")
    response = _post(
        auth_client,
        {
            "account_id": acct.id,
            "content_type": "a",
            "external_id": "my-asset",
            "manifest": "mpd",
            "ttl_seconds": 120,
            "params": {"rays": "dcba"},
        },
    )
    assert response.status_code == 200
    parts = urlsplit(response.get_json()["url"])
    assert parts.path == "/ext/own1/my-asset.mpd"
    params = dict(parse_qsl(parts.query))
    assert params["eid"] == "my-asset" and params["oid"] == "own1" and params["rays"] == "dcba"


@pytest.mark.parametrize(
    ("body", "match"),
    [
        ({"channel_id": 999}, "Unknown channel"),
        ({"account_id": 999, "content_id": "x"}, "Unknown account"),
        ({"account_id": "abc"}, "integer"),
        ({"__acct__": True, "content_id": "x", "mode": "nope"}, "Unknown mode"),
        ({"__acct__": True, "content_id": "x", "drm": "xx"}, "Unknown DRM"),
        ({"__acct__": True, "content_id": "x", "manifest": "mp4"}, "Unknown manifest"),
        ({"__acct__": True, "content_id": "x", "drm": "wv", "mode": "url"}, "Preplay"),
        (
            {
                "__acct__": True,
                "content_id": "x",
                "drm": "wv",
                "mode": "preplay",
                "manifest": "m3u8",
            },
            "requires the mpd",
        ),
        ({"__acct__": True, "content_id": "x", "params": {"sig": "1"}}, "Reserved"),
        ({"__acct__": True, "content_id": "x", "params": ["a"]}, "params must be"),
        ({"__acct__": True, "content_id": "x", "ttl_seconds": 1}, "TTL"),
        ({"__acct__": True}, "exactly one"),
    ],
)
def test_validation_errors(auth_client, make_account, body, match):
    acct = make_account()
    if body.pop("__acct__", False):
        body["account_id"] = acct.id
    response = _post(auth_client, body)
    assert response.status_code == 400
    assert match in response.get_json()["error"]


def test_non_object_body(auth_client):
    response = auth_client.post("/api/playback", data="x", content_type="text/plain")
    assert response.status_code == 400


def test_preplay_with_drm(auth_client, make_account, make_channel, monkeypatch):
    ch = make_channel(make_account(), "abc")
    seen = {}

    def fake_fetch(url):
        seen["url"] = url
        return PreplayResult(
            play_url="https://content-ause3.uplynk.com/preplay2/x.mpd",
            prefix="https://content-ause3.uplynk.com",
            sid="sid1",
            drm={"required": True, "widevineLicenseURL": "https://content-ause3.uplynk.com/wv"},
            raw={},
        )

    monkeypatch.setattr(service, "fetch_preplay", fake_fetch)
    response = _post(auth_client, {"channel_id": ch.id, "mode": "preplay", "drm": "wv"})
    assert response.status_code == 200
    data = response.get_json()
    assert data["url"].startswith("https://content-ause3.uplynk.com/preplay2/")
    assert data["drm_config"]["widevineLicenseURL"].endswith("/wv")
    assert data["manifest"] == "mpd"

    parts = urlsplit(seen["url"])
    assert parts.path == "/preplay/channel/abc.json"
    params = dict(parse_qsl(parts.query))
    assert params["manifest"] == "mpd" and params["rmt"] == "wv"
    # manifest/rmt are inside the signed portion (before sig)
    assert parts.query.index("rmt=wv") < parts.query.index("&sig=")
    # drm.required marks the channel for the dashboard badge
    db.session.refresh(ch)
    assert ch.encryption == "drm" and ch.encryption_checked_at is not None


def test_preplay_failure_is_audited(auth_client, make_account, make_channel, monkeypatch):
    ch = make_channel(make_account(), "abc")

    def boom(url):
        raise PlaybackError("Preplay returned HTTP 403: nope")

    monkeypatch.setattr(service, "fetch_preplay", boom)
    response = _post(auth_client, {"channel_id": ch.id, "mode": "preplay"})
    assert response.status_code == 400
    event = db.session.query(PlaybackEvent).one()
    assert "403" in event.error


def test_channels_endpoint(auth_client, make_account, make_channel):
    acct = make_account()
    make_channel(acct, "a1", description="Alpha")
    make_channel(acct, "a2", is_active=False)
    items = auth_client.get("/api/channels").get_json()["items"]
    assert [i["channel_id"] for i in items] == ["a1"]
    assert items[0]["account"] == "demo"


def test_signed_url_is_probed(auth_client, make_account, make_channel, probe_calls):
    ch = make_channel(make_account(), "abc")
    data = _post(auth_client, {"channel_id": ch.id}).get_json()
    assert probe_calls == [data["url"]]
    assert data["probe"] == {
        "ok": True,
        "status": 200,
        "error": None,
        "elapsed_ms": 5,
        "encryption": None,
    }
    event = db.session.get(PlaybackEvent, data["event_id"])
    assert event.status_code == 200 and event.error is None


def test_probe_failure_is_returned_and_audited(
    auth_client, make_account, make_channel, probe_calls
):
    ch = make_channel(make_account(), "abc")
    probe_calls.result = ProbeResult(False, 400, "HTTP 400: Non dash asset xyz", 12)
    response = _post(auth_client, {"channel_id": ch.id, "manifest": "mpd"})
    assert response.status_code == 200  # the URL is still signed correctly
    data = response.get_json()
    assert data["url"] and data["probe"]["ok"] is False
    assert "Non dash asset" in data["probe"]["error"]
    event = db.session.get(PlaybackEvent, data["event_id"])
    assert event.status_code == 400 and "Non dash asset" in event.error


def test_probe_can_be_skipped(auth_client, make_account, make_channel, probe_calls):
    ch = make_channel(make_account(), "abc")
    data = _post(auth_client, {"channel_id": ch.id, "probe": False}).get_json()
    assert probe_calls == [] and "probe" not in data


def test_preplay_probes_the_play_url(
    auth_client, make_account, make_channel, monkeypatch, probe_calls
):
    ch = make_channel(make_account(), "abc")
    play_url = "https://content-ause1.uplynk.com/preplay2/channel/abc/x.m3u8?pbs=1"
    monkeypatch.setattr(
        service, "fetch_preplay", lambda url: PreplayResult(play_url, None, "s", None, {})
    )
    _post(auth_client, {"channel_id": ch.id, "mode": "preplay"})
    assert probe_calls == [play_url]


def test_probe_records_channel_encryption(auth_client, make_account, make_channel, probe_calls):
    ch = make_channel(make_account())
    probe_calls.result = ProbeResult(True, 200, None, 5, "drm")
    data = _post(auth_client, {"channel_id": ch.id}).get_json()
    assert data["probe"]["encryption"] == "drm"
    db.session.refresh(ch)
    assert ch.encryption == "drm"
    items = auth_client.get("/api/channels").get_json()["items"]
    assert items[0]["encryption"] == "drm"


def test_unknown_encryption_keeps_previous(auth_client, make_account, make_channel, probe_calls):
    ch = make_channel(make_account(), encryption="aes-128")
    probe_calls.result = ProbeResult(True, 200, None, 5, None)
    _post(auth_client, {"channel_id": ch.id, "manifest": "mpd"})
    db.session.refresh(ch)
    assert ch.encryption == "aes-128"


def test_check_encryption_signs_and_records(app, make_account, make_channel, monkeypatch):
    account = make_account()
    clear = make_channel(account, "chan0001")
    drm = make_channel(account, "chan0002")
    answers = {"chan0001": "none", "chan0002": "drm"}
    probed = []

    def fake(url):
        probed.append(url)
        cid = dict(parse_qsl(urlsplit(url).query))["cid"]
        return ProbeResult(True, 200, None, 5, answers[cid])

    monkeypatch.setattr(service, "probe_manifest", fake)
    results = service.check_encryption([clear, drm], workers=2)
    assert [p.encryption for _, p in results] == ["none", "drm"]
    assert all(".m3u8?" in u and "&sig=" in u for u in probed)
    assert (clear.encryption, drm.encryption) == ("none", "drm")
    assert db.session.query(PlaybackEvent).count() == 0
