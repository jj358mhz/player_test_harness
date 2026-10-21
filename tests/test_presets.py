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
        (
            "cmcd=1&engine=shaka&ad.lib=KOR&ad=fw2&ad.kv=a%2Cb",
            "engine=shaka&ad=fw2&ad.lib=KOR&ad.kv=a%2Cb&cmcd=1",
        ),
        # Uplynk params ride after ad=; expand= lets ad.* go without an ad server.
        (
            "ifo=1&engine=shaka&expand=ad_01%2Cpb_01&ad.flex=10",
            "engine=shaka&ifo=1&expand=ad_01%2Cpb_01&ad.flex=10",
        ),
        ("engine=shaka&fp.hd.hdcp=-1", "engine=shaka&fp.hd.hdcp=-1"),
        # v3.22.0's packed form reads as the plain one.
        ("engine=shaka&ad=fw2&adp=ad.lib%3DKOR", "engine=shaka&ad=fw2&ad.lib=KOR"),
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
        "engine=hlsjs&ad.lib=KOR",  # params without an ad server
        "engine=hlsjs&ad=fw2&adp=delay%3D20",
        "engine=hlsjs&ad=fw2&ad.lib=%3Cx%3E",
        "engine=hlsjs&ad=fw2&" + "&".join(f"ad.k{i}=v" for i in range(21)),
        "engine=hlsjs&expand=a%20b",
        "engine=hlsjs&sig=abc",
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


def test_describe():
    from app.presets import describe

    d = describe("format=dash&engine=shaka@5.3.0&drm=wv&delay=20&ad=fw2&ad.lib=KOR&cmcd=1")
    assert d["parts"] == [
        "DASH",
        "Shaka 5.3.0",
        "Widevine",
        "delay 20 s",
        "ad=fw2 ad.lib=KOR",
        "CMCD",
    ]
    assert d["fields"]["params"] == "ad.lib=KOR"
    assert describe("engine=hlsjs&expand=pb_01&ifo=1")["parts"][-1] == "expand=pb_01 ifo=1"
    assert d["fields"]["version"] == "5.3.0"
    assert describe("engine=hlsjs")["parts"] == ["HLS", "hls.js (default version)"]


def _form(**fields):
    base = {"name": "Shaka DASH", "format": "dash", "engine": "shaka", "version": ""}
    return {**base, **fields}


def test_page_adds_edits_and_deletes(auth_client):
    from app.models import EnginePreset, db

    r = auth_client.post(
        "/presets",
        data=_form(drm="wv", delay="30", ad="fw2", params=" ad.lib=KOR & ad.flex=10 ", cmcd="1"),
    )
    assert r.status_code == 302
    row = db.session.query(EnginePreset).one()
    assert (
        row.query == "format=dash&engine=shaka&drm=wv&delay=30&ad=fw2&ad.lib=KOR&ad.flex=10&cmcd=1"
    )

    page = auth_client.get("/presets").get_data(as_text=True)
    assert "Shaka DASH" in page and "ad=fw2 ad.lib=KOR ad.flex=10" in page
    assert f'href="/player?preset={row.id}"' in page

    # Edit renames in place and the form is filled from the stored query.
    edit = auth_client.get(f"/presets?edit={row.id}").get_data(as_text=True)
    assert 'value="ad.lib=KOR&amp;ad.flex=10"' in edit
    r = auth_client.post(
        "/presets", data=_form(name="Shaka 5", version="5.3.0", preset_id=str(row.id))
    )
    assert r.status_code == 302
    db.session.refresh(row)
    assert (row.name, row.query) == ("Shaka 5", "format=dash&engine=shaka@5.3.0")
    assert db.session.query(EnginePreset).count() == 1

    assert auth_client.post(f"/presets/{row.id}/delete").status_code == 302
    assert db.session.query(EnginePreset).count() == 0
    assert auth_client.post(f"/presets/{row.id}/delete").status_code == 404


@pytest.mark.parametrize(
    ("fields", "message"),
    [
        ({"version": "latest"}, "bad engine version"),
        ({"params": "ad.lib=KOR"}, "ad.lib needs an ad server"),
        ({"ad": "fw2", "params": "lib=KOR"}, "lib isn't a param this player signs"),
        ({"ad": "fw2", "params": "ad.lib"}, "needs a value"),
        ({"params": "rays=fe"}, "pick rays in the ABR tab"),
        ({"name": " "}, "name is required"),
    ],
)
def test_page_rejects_and_keeps_input(auth_client, fields, message):
    r = auth_client.post("/presets", data=_form(**fields))
    assert r.status_code == 400
    page = r.get_data(as_text=True)
    assert message in page.replace("&#39;", "'")
    assert 'value="dash" selected' in page  # what was typed stays


def test_page_rename_cannot_take_another_name(auth_client):
    from app.models import EnginePreset, db

    auth_client.post("/presets", data=_form(name="One"))
    auth_client.post("/presets", data=_form(name="Two", engine="dashjs"))
    two = db.session.query(EnginePreset).filter_by(name="Two").one()
    r = auth_client.post("/presets", data=_form(name="One", preset_id=str(two.id)))
    assert r.status_code == 400
    assert "already called" in r.get_data(as_text=True)


def test_player_opens_with_a_preset(auth_client, monkeypatch):
    from app.main import routes

    monkeypatch.setattr(routes, "vite_assets", lambda entry="": {"js": "/x.js", "css": []})
    page = auth_client.get("/player?preset=7").get_data(as_text=True)
    assert '"initialPreset": 7' in page
    assert '"presetsPage": "/presets"' in page


def test_page_heading_says_what_it_counts(auth_client):
    auth_client.post("/presets", data=_form())
    assert '<span class="page-header__meta">1 saved</span>' in auth_client.get("/presets").get_data(
        as_text=True
    )
