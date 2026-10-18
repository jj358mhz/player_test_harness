"""Recorded player sessions: save, redact, replay, delete, prune."""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime, timedelta

import pytest

from app.models import PlaybackSession, db
from app.sessions import prune_sessions, redact

SIGNED = "https://content.example.com/channel/chan0001.m3u8?tc=1&exp=9&rn=1&ct=c&cid=chan0001&sig=deadbeef"


def recording(**overrides):
    now = int(time.time() * 1000)
    data = {
        "v": 1,
        "title": "Channel chan0001",
        "source": {
            "channel": None,
            "url": SIGNED,
            "format": "m3u8",
            "engine": "hls.js",
            "version": "1.7.3",
            "drm": None,
            "link": "channel=1&engine=hlsjs@1.7.3",
        },
        "startedAt": now - 120_000,
        "endedAt": now,
        "live": True,
        "userAgent": "test",
        "latencyName": "ID3",
        "stats": {"latency": {"count": 3, "last": 9.5, "avg": 9.0, "min": 8.5, "max": 9.5}},
        "counters": {"rebuffers": 2, "errors": 1},
        "series": {"latency": [{"t": now - 1000, "v": 9.0}], "drift": []},
        "events": [],
        "breaks": [],
        "log": [
            {"t": now, "kind": "info", "label": "LOAD", "text": f"{SIGNED}&amp;pbs=sess123"},
        ],
        "renditions": [],
        "requestStats": {},
        "requests": [],
        "drm": {
            "keySystem": "com.widevine.alpha",
            "licenseServer": "https://content-x.example.com/wv?b=1&c=chan0001&tok=secret",
            "robustness": "SW_SECURE_CRYPTO",
            "keyStatuses": {},
        },
        "playlist": None,
    }
    data.update(overrides)
    return data


def save(client, data):
    return client.post("/api/sessions", data=json.dumps(data), content_type="application/json")


def test_save_requires_login(client):
    assert save(client, recording()).status_code in (302, 401)


def test_save_redacts_and_links(auth_client, make_account, make_channel):
    ch = make_channel(make_account())
    response = save(auth_client, recording(source={**recording()["source"], "channel": ch.id}))
    assert response.status_code == 201
    body = response.get_json()
    assert body["url"] == f"/sessions/{body['id']}"
    assert body["retention_days"] == 30

    row = db.session.query(PlaybackSession).filter_by(slug=body["id"]).one()
    assert row.channel_id == ch.id
    assert (row.engine, row.engine_version, row.manifest) == ("hls.js", "1.7.3", "m3u8")
    assert row.latency_avg == 9.0 and row.rebuffers == 2 and row.errors == 1
    assert 115 <= row.duration_s <= 125
    # Nothing that would replay: no signature, no session token, no license query
    assert "deadbeef" not in row.data and "sess123" not in row.data and "secret" not in row.data
    stored = json.loads(row.data)
    assert stored["drm"]["licenseServer"] == "https://content-x.example.com/wv"
    assert stored["source"]["url"].endswith("&sig=…")


@pytest.mark.parametrize(
    "bad",
    [
        [],
        {"v": 2},
        recording(source="nope"),
        recording(series=None),
        recording(startedAt="yesterday"),
        recording(startedAt=2_000_000_000_000, endedAt=1_000_000_000_000),
    ],
)
def test_save_rejects_bad_recordings(auth_client, bad):
    response = save(auth_client, bad)
    assert response.status_code == 400
    assert response.get_json()["error"]
    assert db.session.query(PlaybackSession).count() == 0


def test_save_rejects_oversized(app, auth_client):
    app.config["MAX_RECORDING_BYTES"] = 2000
    big = recording(log=[{"t": 1, "kind": "info", "label": "X", "text": "y" * 5000}])
    assert save(auth_client, big).status_code == 413


def test_session_pages(auth_client, monkeypatch):
    from app.main import routes

    monkeypatch.setattr(
        routes,
        "vite_assets",
        lambda entry="src/main.ts": {"js": f"/static/player/{entry}.js", "css": []},
    )
    slug = save(auth_client, recording()).get_json()["id"]
    listing = auth_client.get("/sessions").get_data(as_text=True)
    assert f"/sessions/{slug}" in listing and "Channel chan0001" in listing
    assert "9.0 / 9.5 s" in listing

    page = auth_client.get(f"/sessions/{slug}").get_data(as_text=True)
    assert 'src="/static/player/src/recording.ts.js"' in page
    assert 'id="recording-data"' in page and "deadbeef" not in page
    assert 'href="/player?channel=1&amp;engine=hlsjs@1.7.3"' in page

    download = auth_client.get(f"/api/sessions/{slug}")
    assert download.headers["Content-Disposition"].startswith("attachment;")
    assert download.get_json()["title"] == "Channel chan0001"

    assert auth_client.get("/sessions/nope").status_code == 404
    assert auth_client.post(f"/sessions/{slug}/delete").status_code == 302
    assert auth_client.get(f"/sessions/{slug}").status_code == 404


def test_session_json_is_script_safe(auth_client, monkeypatch):
    from app.main import routes

    monkeypatch.setattr(routes, "vite_assets", lambda entry="": {"js": "/x.js", "css": []})
    slug = save(auth_client, recording(title="</script><script>alert(1)</script>")).get_json()["id"]
    page = auth_client.get(f"/sessions/{slug}").get_data(as_text=True)
    assert "</script><script>alert(1)" not in page


def test_prune_respects_retention(app, auth_client):
    keep = save(auth_client, recording()).get_json()["id"]
    old = db.session.query(PlaybackSession).filter_by(slug=keep).one()
    old.created_at = datetime.now(UTC) - timedelta(days=45)
    db.session.commit()
    save(auth_client, recording())  # saving prunes too
    assert db.session.query(PlaybackSession).count() == 1

    old = db.session.query(PlaybackSession).one()
    old.created_at = datetime.now(UTC) - timedelta(days=3)
    db.session.commit()
    assert prune_sessions(days=0) == 0  # 0 = keep forever
    assert prune_sessions(days=2) == 1


def test_prune_cli(app):
    result = app.test_cli_runner().invoke(args=["prune-sessions", "--days", "7"])
    assert result.exit_code == 0 and "Deleted 0" in result.output


def test_redact_catches_encoded_signatures():
    link = "src=https://h/c.m3u8%3Ftc%3D1%26sig%3Dabc123%26pbs%3Dsess&engine=hlsjs"
    assert redact(link) == "src=https://h/c.m3u8%3Ftc%3D1%26sig%3D…%26pbs%3D…&engine=hlsjs"


def test_redact_masks_preplay_session_paths():
    url = "https://content-x.example.com/preplay2/channel/chan0001/sid0001/tok123.mpd?pbs=s1"
    assert redact(url) == "https://content-x.example.com/preplay2/channel/chan0001/…?pbs=…"


def test_redact_walks_everything():
    out = redact({"a": [f"x {SIGNED}"], "licenseUrl": "https://h/wv?x=1", "n": 3})
    assert out == {
        "a": [f"x {SIGNED.replace('deadbeef', '…')}"],
        "licenseUrl": "https://h/wv",
        "n": 3,
    }
