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
    assert set(kwargs["params"]) == {"msg", "sig"}
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
    assert kwargs["params"] == {}
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
