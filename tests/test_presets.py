"""Saved engine presets: validation, API, player config."""

from __future__ import annotations

import pytest

from app.presets import PresetError, normalize_query


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("engine=hlsjs", "engine=hlsjs"),
        ("format=hls&engine=hlsjs@1.6.15", "engine=hlsjs@1.6.15"),
        (
            "cmcd=1&delay=020&drm=wv&engine=shaka@5.3.0&format=dash",
            "format=dash&engine=shaka@5.3.0&drm=wv&delay=20&cmcd=1",
        ),
        # The source and per-channel choices are dropped, not stored.
        (
            "channel=4&src=https://x.example.com/a.m3u8&rays=fe&tab=abr&engine=native",
            "engine=native",
        ),
        ("?engine=dashjs&cmcd=0", "engine=dashjs"),
        ("cmcd=1&ad=fw2&engine=shaka&delay=20", "engine=shaka&delay=20&ad=fw2&cmcd=1"),
    ],
)
def test_normalize(query, expected):
    assert normalize_query(query) == expected


@pytest.mark.parametrize(
    "query",
    [
        "format=dash",  # no engine
        "engine=vlc",
        "engine=hlsjs@../../evil",
        "engine=hlsjs@latest",
        "engine=native@1.0.0",
        "engine=hlsjs&drm=clearkey",
        "engine=hlsjs&delay=601",
        "engine=hlsjs&delay=-5",
        "engine=hlsjs&format=smooth",
        "engine=hlsjs&debug=1",
        "engine=hlsjs&ad=../../x",
        "engine=hlsjs&" + "x" * 300,
    ],
)
def test_rejects(query):
    with pytest.raises(PresetError):
        normalize_query(query)


def test_crud(auth_client):
    assert auth_client.get("/api/presets").get_json() == {"items": []}
    r = auth_client.post(
        "/api/presets", json={"name": "  Shaka   DASH  ", "query": "engine=shaka&format=dash"}
    )
    assert r.status_code == 201
    preset = r.get_json()["preset"]
    assert preset["name"] == "Shaka DASH"
    assert preset["query"] == "format=dash&engine=shaka"

    # Same name replaces.
    r = auth_client.post(
        "/api/presets", json={"name": "Shaka DASH", "query": "engine=shaka&format=dash&cmcd=1"}
    )
    assert r.status_code == 200
    items = r.get_json()["items"]
    assert len(items) == 1 and items[0]["query"].endswith("cmcd=1")

    auth_client.post("/api/presets", json={"name": "A first", "query": "engine=hlsjs"})
    names = [p["name"] for p in auth_client.get("/api/presets").get_json()["items"]]
    assert names == ["A first", "Shaka DASH"]

    r = auth_client.delete(f"/api/presets/{preset['id']}")
    assert [p["name"] for p in r.get_json()["items"]] == ["A first"]
    assert auth_client.delete(f"/api/presets/{preset['id']}").status_code == 404


@pytest.mark.parametrize(
    "body",
    [
        None,
        {"name": "", "query": "engine=hlsjs"},
        {"name": "x" * 61, "query": "engine=hlsjs"},
        {"name": "ok", "query": "engine=hlsjs@nope"},
        {"name": "ok", "query": 5},
    ],
)
def test_create_errors(auth_client, body):
    assert auth_client.post("/api/presets", json=body).status_code == 400


def test_requires_login(client):
    assert client.get("/api/presets").status_code in (302, 401)
    assert client.post("/api/presets", json={}).status_code in (302, 401)


def test_player_config_lists_presets(auth_client, monkeypatch):
    from app.main import routes

    monkeypatch.setattr(routes, "vite_assets", lambda entry="": {"js": "/x.js", "css": []})
    auth_client.post("/api/presets", json={"name": "Native", "query": "engine=native"})
    page = auth_client.get("/player").get_data(as_text=True)
    assert '"presets": "/api/presets"' in page
    assert '"name": "Native"' in page
