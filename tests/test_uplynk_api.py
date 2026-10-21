"""Tests for Uplynk API auth helpers and the channels client."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import zlib

import jwt
import pytest
import requests

from app.uplynk.auth import UplynkAuthError, build_jwt, classic_auth_params
from app.uplynk.channels import ScopedCredentials, UplynkAPIError, UplynkChannelsClient
from tests.conftest import FakeResponse, FakeSession

CHANNEL_ITEM = {
    "use_chsched": 1,
    "created": "2016-10-04T17:09:41.570Z",
    "@id": "/channels/c892",
    "id": "c892",
    "slicer_id": "sales03",
    "thumb_url": "",
    "external_id": "",
    "@type": "Channel",
    "desc": "Sales Conferences",
}


def test_classic_auth_params_roundtrip():
    params = classic_auth_params("owner1", "secret", now=1234)
    msg = params["msg"].encode()
    body = json.loads(zlib.decompress(base64.b64decode(msg)))
    assert body == {"_owner": "owner1", "_timestamp": 1234}
    assert params["sig"] == hmac.new(b"secret", msg, hashlib.sha256).hexdigest()


def test_classic_auth_requires_credentials():
    with pytest.raises(UplynkAuthError):
        classic_auth_params("", "secret")


def test_build_jwt_claims(ec_keypair):
    token = build_jwt("kid1", "sub1", ec_keypair["private_b64"], "a:read, b:write", now=1000)
    claims = jwt.decode(
        token, ec_keypair["public_key"], algorithms=["ES256"], options={"verify_exp": False}
    )
    assert claims == {"iat": 1000, "exp": 1300, "sub": "sub1", "scp": ["a:read", "b:write"]}
    assert jwt.get_unverified_header(token)["kid"] == "kid1"


def test_build_jwt_bad_key():
    with pytest.raises(UplynkAuthError):
        build_jwt("k", "s", base64.b64encode(b"not a pem").decode(), "x")


def _client(response, **kwargs):
    session = FakeSession(response)
    kwargs.setdefault("api_key", "secret")
    client = UplynkChannelsClient(
        "https://services.uplynk.com/", "owner1", session=session, **kwargs
    )
    return client, session


def test_list_channels_classic_auth():
    client, session = _client(FakeResponse(200, {"items": [CHANNEL_ITEM], "total_items": 1}))
    channels = client.list_channels()

    assert client.auth_mode == "classic"
    url, kwargs = session.calls[0]
    assert url == "https://services.uplynk.com/api/v4/channels"
    assert set(kwargs["params"]) == {"msg", "sig", "page"}
    assert "X-Auth-Uplynk-Jwt" not in kwargs["headers"]

    [ch] = channels
    assert ch.channel_id == "c892"
    assert ch.description == "Sales Conferences"
    assert ch.slicer_id == "sales03"
    assert ch.external_id is None  # empty strings normalised
    assert ch.thumb_url is None


def test_list_channels_prefers_scoped_key(ec_keypair):
    scoped = ScopedCredentials(
        "kid1", "sub1", ec_keypair["private_b64"], "video.services.channels:read"
    )
    client, session = _client(FakeResponse(200, {"items": []}), scoped=scoped)
    assert client.list_channels() == []
    assert client.auth_mode == "scoped"
    _, kwargs = session.calls[0]
    assert kwargs["params"] == {"page": 1}
    assert kwargs["headers"]["X-Auth-Uplynk-Jwt"]


@pytest.mark.parametrize(
    ("response", "match"),
    [
        (FakeResponse(401), "401"),
        (FakeResponse(403), "video.services.channels:read"),
        (FakeResponse(500, text="boom"), "HTTP 500"),
        (FakeResponse(200, None, text="<html>"), "non-JSON"),
        (FakeResponse(200, {"error": 1, "msg": "bad sig"}), "bad sig"),
        (FakeResponse(200, {"nope": []}), "missing 'items'"),
        (FakeResponse(200, {"items": [{"desc": "no id"}]}), "missing required field"),
        (requests.ConnectionError("down"), "Request to Uplynk failed"),
    ],
)
def test_list_channels_errors(response, match):
    client, _ = _client(response)
    with pytest.raises(UplynkAPIError, match=match):
        client.list_channels()


def test_client_requires_some_credentials():
    with pytest.raises(UplynkAPIError):
        UplynkChannelsClient("https://x", "owner1")


def _item(n):
    return {**CHANNEL_ITEM, "id": f"chan{n:04d}", "@id": f"/channels/chan{n:04d}"}


def _page(start, count, total):
    return FakeResponse(
        200, {"items": [_item(i) for i in range(start, start + count)], "total_items": total}
    )


def test_list_channels_walks_every_page():
    # Uplynk caps pages at 40 items; 142 channels → 4 pages
    pages = [_page(0, 40, 142), _page(40, 40, 142), _page(80, 40, 142), _page(120, 22, 142)]
    client, session = _client(pages)
    channels = client.list_channels()
    assert len(channels) == 142
    assert [kw["params"]["page"] for _, kw in session.calls] == [1, 2, 3, 4]
    assert len({c.channel_id for c in channels}) == 142


def test_list_channels_stops_on_empty_page_without_total():
    no_total = FakeResponse(200, {"items": [_item(1)]})
    client, session = _client([no_total, FakeResponse(200, {"items": []})])
    assert len(client.list_channels()) == 1
    assert len(session.calls) == 2


def test_list_channels_fails_rather_than_return_a_partial_list():
    # total says 50 but the second page comes back empty: don't let sync
    # deactivate the 10 we never saw.
    client, _ = _client([_page(0, 40, 50), FakeResponse(200, {"items": [], "total_items": 50})])
    with pytest.raises(UplynkAPIError, match="reported 50 channels but only 40"):
        client.list_channels()


def test_list_channels_error_on_a_later_page_fails_the_sync():
    client, _ = _client([_page(0, 40, 80), FakeResponse(500, text="boom")])
    with pytest.raises(UplynkAPIError, match="HTTP 500"):
        client.list_channels()


def _ad_item(name, type_="Promo", provider="vz"):
    # Shape seen 2026-10-20: @id is just the collection path.
    return {
        "@id": "/api/v4/ads/servers/",
        "@type": "AdServer",
        "name": name,
        "type": type_,
        "provider": provider,
    }


def test_list_ad_servers_uses_classic_auth_even_with_a_scoped_key(ec_keypair):
    scoped = ScopedCredentials(
        "kid1", "sub1", ec_keypair["private_b64"], "video.services.channels:read"
    )
    payload = {"items": [_ad_item("adcfg1"), _ad_item("adcfg2", "", "")], "total_items": 2}
    client, session = _client(FakeResponse(200, payload), scoped=scoped)
    servers = client.list_ad_servers()
    url, kwargs = session.calls[0]
    assert url == "https://services.uplynk.com/api/v4/ads/servers"
    assert set(kwargs["params"]) == {"msg", "sig", "page"}
    assert "X-Auth-Uplynk-Jwt" not in kwargs["headers"]
    assert [(s.name, s.type, s.provider) for s in servers] == [
        ("adcfg1", "Promo", "vz"),
        ("adcfg2", None, None),
    ]


@pytest.mark.parametrize(
    ("response", "match"),
    [
        (FakeResponse(403), r"refused /api/v4/ads/servers \(403\)"),
        (FakeResponse(401), "workspace ID / API key"),
        (FakeResponse(200, {"items": [{"type": "x"}]}), "missing a name"),
    ],
)
def test_list_ad_servers_errors(response, match):
    client, _ = _client(response)
    with pytest.raises(UplynkAPIError, match=match):
        client.list_ad_servers()


def test_list_ad_servers_walks_pages():
    pages = [
        FakeResponse(200, {"items": [_ad_item(f"a{i}") for i in range(40)], "total_items": 41}),
        FakeResponse(200, {"items": [_ad_item("a40")], "total_items": 41}),
    ]
    client, session = _client(pages)
    assert len(client.list_ad_servers()) == 41
    assert [kw["params"]["page"] for _, kw in session.calls] == [1, 2]
