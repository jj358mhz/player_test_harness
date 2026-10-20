"""Ad servers (SSAI ad configuration names) per account."""

from __future__ import annotations

import json
import re

import pytest

from app.ads import AdServerError, clean_name, clean_params
from app.models import AdServer, db


def test_clean_name():
    assert clean_name("  fw2 ") == "fw2"
    for bad in ("", "a b", "x/y", "ad=fw2", "x" * 101, None):
        with pytest.raises(AdServerError):
            clean_name(bad)


def test_clean_params():
    assert clean_params("") is None
    assert clean_params("?ad.breakend=chop&ad.flex=10") == "ad.breakend=chop&ad.flex=10"
    assert clean_params("ad.kv=genre%3Dnews") == "ad.kv=genre%3Dnews"
    for bad in ("delay=20", "ad=fw2", "ad.=x", "ad.x=" + "y" * 600):
        with pytest.raises(AdServerError):
            clean_params(bad)


def test_admin_add_and_remove(auth_client, make_account):
    account = make_account()
    url = f"/admin/uplynk-accounts/{account.id}/ad-servers"
    r = auth_client.post(
        url, data={"name": "fw2", "description": "FreeWheel", "params": "ad.breakend=chop"}
    )
    assert r.status_code == 302 and r.headers["Location"].endswith("#ad-servers")
    row = db.session.query(AdServer).one()
    assert (row.name, row.description, row.params) == ("fw2", "FreeWheel", "ad.breakend=chop")

    # Duplicates and bad input are refused with a message, nothing stored.
    page = auth_client.post(url, data={"name": "fw2"}, follow_redirects=True).get_data(as_text=True)
    assert "already listed" in page
    auth_client.post(url, data={"name": "x y"})
    assert db.session.query(AdServer).count() == 1

    page = auth_client.get(f"/admin/uplynk-accounts/{account.id}/edit").get_data(as_text=True)
    assert 'id="ad-servers"' in page and ">fw2<" in page

    auth_client.post(f"/admin/uplynk-accounts/{account.id}/ad-servers/{row.id}/delete")
    assert db.session.query(AdServer).count() == 0
    assert (
        auth_client.post(
            f"/admin/uplynk-accounts/{account.id}/ad-servers/{row.id}/delete"
        ).status_code
        == 404
    )


def test_account_delete_takes_ad_servers(auth_client, make_account):
    account = make_account()
    auth_client.post(f"/admin/uplynk-accounts/{account.id}/ad-servers", data={"name": "fw2"})
    auth_client.post(f"/admin/uplynk-accounts/{account.id}/delete")
    assert db.session.query(AdServer).count() == 0


def test_player_config_has_ad_servers(auth_client, make_account, make_channel, monkeypatch):
    from app.main import routes

    monkeypatch.setattr(routes, "vite_assets", lambda entry="": {"js": "/x.js", "css": []})
    account = make_account()
    channel = make_channel(account)
    auth_client.post(
        f"/admin/uplynk-accounts/{account.id}/ad-servers",
        data={"name": "fw2", "params": "ad.flex=10"},
    )
    page = auth_client.get("/player").get_data(as_text=True)
    config = json.loads(
        re.search(r'<script id="player-config" type="application/json">(.*?)</script>', page, re.S)[
            1
        ]
    )
    assert config["adServers"] == {
        str(account.id): [{"name": "fw2", "description": None, "params": "ad.flex=10"}]
    }
    assert config["channels"][0]["accountId"] == account.id == channel.uplynk_account_id


def test_signing_with_ad_params(auth_client, make_account, make_channel):
    """The player sends ad= and ad.* as signed params; the server signs them in."""
    channel = make_channel(make_account())
    r = auth_client.post(
        "/api/playback",
        json={
            "channel_id": channel.id,
            "manifest": "m3u8",
            "params": {"ad": "fw2", "ad.flex": "10"},
        },
    )
    url = r.get_json()["url"]
    assert "&ad=fw2&ad.flex=10&sig=" in url
