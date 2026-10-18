"""Tests for POST /api/playback and the playback audit trail."""

from __future__ import annotations

from urllib.parse import parse_qsl, urlsplit

import pytest

from app.api import service
from app.models import PlaybackEvent, db
from app.uplynk.playback import PlaybackError, PreplayResult


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
