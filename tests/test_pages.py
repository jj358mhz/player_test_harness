"""Tests for page routes and the account admin flow."""

from __future__ import annotations

import io

import pytest

from app.crypto import decrypt
from app.models import AdminEvent, UplynkAccount, db
from app.uplynk.sync import SyncResult


@pytest.mark.parametrize(
    "path",
    [
        "/",
        "/player",
        "/compare",
        "/sign",
        "/activity",
        "/sessions",
        "/admin/uplynk-accounts",
        "/api/channels",
    ],
)
def test_pages_require_login(client, path):
    response = client.get(path)
    assert response.status_code == 302
    assert "/auth/login" in response.headers["Location"]


@pytest.mark.parametrize(
    "path",
    ["/", "/player", "/compare", "/sign", "/activity", "/sessions", "/admin/uplynk-accounts"],
)
def test_pages_render(auth_client, path):
    assert auth_client.get(path).status_code == 200


def test_dashboard_lists_channels_grouped(auth_client, make_account, make_channel):
    make_channel(make_account("acct-a"), "c1", description="Alpha Channel")
    make_channel(make_account("acct-b"), "c2", description="Beta Channel")
    html = auth_client.get("/").get_data(as_text=True)
    assert "Alpha Channel" in html and "Beta Channel" in html
    assert html.index("acct-a") < html.index("acct-b")


def test_player_page_without_build_explains(auth_client, monkeypatch):
    from app.main import routes

    monkeypatch.setattr(routes, "vite_assets", lambda: None)
    html = auth_client.get("/player").get_data(as_text=True)
    assert "Player not built" in html and "npm --prefix frontend" in html


def test_player_page_embeds_config_and_assets(auth_client, make_account, make_channel, monkeypatch):
    import json
    import re

    from app.main import routes

    monkeypatch.setattr(
        routes,
        "vite_assets",
        lambda: {
            "js": "/static/player/assets/main-abc.js",
            "css": ["/static/player/assets/main.css"],
        },
    )
    ch = make_channel(make_account(), "abc", description="Alpha", encryption="drm")
    html = auth_client.get(f"/player?channel={ch.id}").get_data(as_text=True)
    assert '<script type="module" src="/static/player/assets/main-abc.js">' in html
    assert '<link rel="stylesheet" href="/static/player/assets/main.css">' in html
    raw = re.search(
        r'<script id="player-config" type="application/json">(.*?)</script>', html, re.S
    )
    config = json.loads(raw.group(1))
    assert config["initialChannel"] == ch.id
    assert config["channels"][0]["name"] == "Alpha"
    assert config["channels"][0]["encryption"] == "drm"
    assert config["endpoints"]["versions"] == {
        "hls.js": "/api/engines/hls.js/versions",
        "shaka-player": "/api/engines/shaka-player/versions",
        "dashjs": "/api/engines/dashjs/versions",
    }
    assert "api_key" not in raw.group(1)  # keys never reach the browser


def test_play_channel_opens_player_on_channel(auth_client, make_account, make_channel, probe_calls):
    ch = make_channel(make_account(), "abc")
    response = auth_client.get(f"/channels/{ch.id}/play")
    assert response.status_code == 302
    assert response.headers["Location"] == f"/player?channel={ch.id}"
    assert probe_calls == []  # the player signs and checks it


def test_play_unknown_channel_404(auth_client):
    assert auth_client.get("/channels/999/play").status_code == 404


def test_toggle_favorite(auth_client, make_account, make_channel):
    ch = make_channel(make_account())
    auth_client.post(f"/channels/{ch.id}/favorite")
    db.session.refresh(ch)
    assert ch.is_favorite
    auth_client.post(f"/channels/{ch.id}/favorite")
    db.session.refresh(ch)
    assert not ch.is_favorite


def test_create_account_encrypts_key(auth_client):
    response = auth_client.post(
        "/admin/uplynk-accounts/new",
        data={"label": "ws1", "workspace_id": "own1", "api_key": "plain-secret"},
        follow_redirects=True,
    )
    assert b"created" in response.data
    acct = db.session.query(UplynkAccount).one()
    assert acct.api_key_encrypted != "plain-secret"
    assert decrypt(acct.api_key_encrypted) == "plain-secret"
    assert db.session.query(AdminEvent).filter_by(action="create").count() == 1
    # the list page shows a masked preview, never the key
    listing = auth_client.get("/admin/uplynk-accounts").get_data(as_text=True)
    assert "plain-secret" not in listing


def test_create_account_requires_api_key(auth_client):
    response = auth_client.post(
        "/admin/uplynk-accounts/new",
        data={"label": "ws1", "workspace_id": "own1"},
        follow_redirects=True,
    )
    assert b"API Key is required" in response.data
    assert db.session.query(UplynkAccount).count() == 0


def test_create_account_with_scoped_env(auth_client, ec_keypair):
    env = (
        f"KID=kid1\nSUB=sub1\nPRIVATE_B64={ec_keypair['private_b64']}\n"
        "SCP=video.services.channels:read\n"
    )
    auth_client.post(
        "/admin/uplynk-accounts/new",
        data={
            "label": "ws1",
            "workspace_id": "own1",
            "api_key": "k",
            "scoped_env_file": (io.BytesIO(env.encode()), "key.env"),
        },
        content_type="multipart/form-data",
    )
    acct = db.session.query(UplynkAccount).one()
    assert acct.has_scoped_key
    assert decrypt(acct.scoped_private_b64_encrypted) == ec_keypair["private_b64"]
    html = auth_client.get(f"/admin/uplynk-accounts/{acct.id}/edit").get_data(as_text=True)
    assert "video.services.channels:read" in html
    assert "lacks video.services.channels:read" not in html


def test_edit_account_blank_key_keeps_existing(auth_client, make_account):
    acct = make_account(api_key="original")
    auth_client.post(
        f"/admin/uplynk-accounts/{acct.id}/edit",
        data={"label": "renamed", "workspace_id": "own2", "api_key": ""},
    )
    db.session.refresh(acct)
    assert acct.label == "renamed"
    assert decrypt(acct.api_key_encrypted) == "original"


def test_delete_scoped_key(auth_client, make_account):
    acct = make_account(
        scoped_kid="k", scoped_sub="s", scoped_private_b64_encrypted="x", scoped_scp="y"
    )
    auth_client.post(f"/admin/uplynk-accounts/{acct.id}/scoped-key/delete")
    db.session.refresh(acct)
    assert not acct.has_scoped_key


def test_delete_account_cascades_channels(auth_client, make_account, make_channel):
    from app.models import Channel

    acct = make_account()
    make_channel(acct)
    auth_client.post(f"/admin/uplynk-accounts/{acct.id}/delete")
    assert db.session.query(UplynkAccount).count() == 0
    assert db.session.query(Channel).count() == 0


def test_sync_route_flashes_and_logs(auth_client, make_account, monkeypatch):
    acct = make_account()
    monkeypatch.setattr(
        "app.admin.routes.sync_account",
        lambda a: SyncResult(a.id, a.label, auth_mode="classic", created=2),
    )
    response = auth_client.post(f"/admin/uplynk-accounts/{acct.id}/sync", follow_redirects=True)
    assert b"2 new" in response.data
    assert db.session.query(AdminEvent).filter_by(category="sync", action="run").count() == 1


def test_non_admin_cannot_manage_accounts(app, client):
    from app.auth.passwords import hash_password
    from app.models import User

    db.session.add(User(email="viewer@example.com", password_hash=hash_password("pw-123456")))
    db.session.commit()
    client.post("/auth/login", data={"email": "viewer@example.com", "password": "pw-123456"})
    assert client.get("/admin/uplynk-accounts").status_code == 403
    assert client.get("/").status_code == 200


def test_sign_page_for_channel_links_back_to_its_card(auth_client, make_account, make_channel):
    ch = make_channel(make_account(), "abc", description="Alpha")
    html = auth_client.get(f"/sign?channel={ch.id}").get_data(as_text=True)
    assert f'href="/#channel-{ch.id}">← Back to channels</a>' in html
    assert "Back to channels" not in auth_client.get("/sign").get_data(as_text=True)


def test_dashboard_has_nav_collapse_and_select_all(auth_client, make_account, make_channel):
    make_channel(make_account("acct-a"), "c1", description="Alpha")
    make_channel(make_account("acct-b"), "c2", description="Beta")
    html = auth_client.get("/").get_data(as_text=True)
    assert 'id="workspace-nav"' in html and 'data-target="section-2"' in html
    assert 'id="collapse-all-btn"' in html and 'id="expand-all-btn"' in html
    assert html.count('class="section-selectall__cb"') == 2
    assert html.count('class="channel-checkbox"') == 2
    assert 'id="batch-bar"' in html


def test_batch_favorite(auth_client, make_account, make_channel):
    from app.models import Channel

    acct = make_account()
    a = make_channel(acct, "c1")
    b = make_channel(acct, "c2")
    response = auth_client.post(
        "/api/channels/favorite", json={"ids": [a.id, b.id], "favorite": True}
    )
    assert response.get_json() == {"updated": 2, "favorite": True}
    assert all(db.session.get(Channel, c.id).is_favorite for c in (a, b))
    auth_client.post("/api/channels/favorite", json={"ids": [a.id], "favorite": False})
    db.session.expire_all()
    assert not db.session.get(Channel, a.id).is_favorite


def test_batch_favorite_validates(auth_client):
    assert auth_client.post("/api/channels/favorite", json={"ids": "x"}).status_code == 400


def test_dashboard_marks_drm_channels(auth_client, make_account, make_channel):
    import re

    account = make_account()
    make_channel(account, "chan0001", description="Clear one", encryption="aes-128")
    make_channel(account, "chan0002", description="Locked one", encryption="drm")
    html = auth_client.get("/").get_data(as_text=True)
    badges = re.findall(r'<span class="badge badge--drm" data-drm-badge[^>]*>', html)
    assert len(badges) == 2
    assert sum("hidden" in b for b in badges) == 1  # only the DRM card shows it
    assert html.count("▶ Play DRM") == 1 and html.count("▶ Play HLS") == 1
    assert "aes-128" not in html.lower()  # Uplynk's default; not worth a badge


def test_player_embed_mode_drops_site_chrome(auth_client, monkeypatch):
    from app.main import routes

    monkeypatch.setattr(
        routes, "vite_assets", lambda entry="src/main.ts": {"js": "/x.js", "css": []}
    )
    full = auth_client.get("/player").get_data(as_text=True)
    pane = auth_client.get("/player?embed=1&channel=3").get_data(as_text=True)
    assert 'class="site-header"' in full and 'href="/compare"' in full
    assert 'class="site-header"' not in pane and "site-main--embed" in pane
    assert '"embed": true' in pane


def test_compare_page(auth_client, make_account, make_channel, monkeypatch):
    from app.main import routes

    monkeypatch.setattr(
        routes, "vite_assets", lambda entry="src/main.ts": {"js": f"/static/{entry}.js", "css": []}
    )
    make_channel(make_account(), "abc", description="Alpha")
    html = auth_client.get("/compare?a=channel%3D1&b=channel%3D1%26format%3Ddash").get_data(
        as_text=True
    )
    assert 'src="/static/src/compare.ts.js"' in html
    assert 'id="compare-config"' in html and '"player": "/player"' in html
    assert "Alpha" in html and "api_key" not in html
