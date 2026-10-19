"""csl-slicer-console settings lookup: client, cache and /api/channels/<id>/slicer."""

from __future__ import annotations

import pytest
import requests

from app import csl
from tests.conftest import FakeResponse, FakeSession

ON = {"slicer_id": "slicer01", "wallclock": True, "captured_at": "2026-10-19T12:00:00Z"}


@pytest.fixture
def console(app, monkeypatch):
    """CSL API configured; returns a function that installs canned responses."""
    app.config["CSL_API_URL"] = "http://csl.example.com"
    app.config["CSL_API_TOKEN"] = "csl-test-token-7f3a"
    csl.clear_cache()

    def install(response):
        session = FakeSession(response)
        monkeypatch.setattr(csl.requests, "get", session.get)
        return session

    yield install
    csl.clear_cache()


@pytest.fixture
def channel(app, make_account, make_channel):
    return make_channel(make_account(), slicer_id="slicer01")


def test_off_without_a_token(auth_client, channel):
    assert auth_client.get(f"/api/channels/{channel.id}/slicer").status_code == 404
    page = auth_client.get("/player").get_data(as_text=True)
    assert '"slicer": null' in page


def test_wallclock_on(auth_client, channel, console):
    session = console(FakeResponse(200, ON))
    body = auth_client.get(f"/api/channels/{channel.id}/slicer").get_json()
    assert body["wallclock"] is True
    assert body["found"] is True
    assert body["captured_at"] == "2026-10-19T12:00:00Z"
    url, kwargs = session.calls[0]
    assert url == "http://csl.example.com/api/slicers/slicer01/settings"
    assert kwargs["headers"] == {"Authorization": "Bearer csl-test-token-7f3a"}


def test_player_gets_the_endpoint(auth_client, channel, console):
    page = auth_client.get("/player").get_data(as_text=True)
    assert '"/api/channels/{id}/slicer"' in page
    assert "csl-test-token-7f3a" not in page


def test_not_in_the_console(auth_client, channel, console):
    console(FakeResponse(404, {"error": "no slicer"}))
    body = auth_client.get(f"/api/channels/{channel.id}/slicer").get_json()
    assert body == {
        "slicer_id": "slicer01",
        "found": False,
        "wallclock": None,
        "captured_at": None,
        "running": None,
        "error": None,
    }


@pytest.mark.parametrize(
    ("response", "error"),
    [
        (FakeResponse(401, {"error": "unauthorized"}), "rejected CSL_API_TOKEN"),
        (FakeResponse(500), "answered 500"),
        (requests.ConnectionError("down"), "unreachable"),
    ],
)
def test_errors(auth_client, channel, console, response, error):
    console(response)
    body = auth_client.get(f"/api/channels/{channel.id}/slicer").get_json()
    assert body["wallclock"] is None
    assert error in body["error"]


def test_caches_answers_not_failures(app, console):
    session = console([requests.ConnectionError("down"), FakeResponse(200, ON)])
    assert csl.slicer_settings("slicer01")["error"]
    assert csl.slicer_settings("slicer01")["wallclock"] is True
    assert csl.slicer_settings("slicer01")["wallclock"] is True
    assert len(session.calls) == 2


def test_channel_without_a_slicer(auth_client, make_account, make_channel, console):
    channel = make_channel(make_account())
    body = auth_client.get(f"/api/channels/{channel.id}/slicer").get_json()
    assert body["slicer_id"] is None
    assert body["wallclock"] is None


def test_api_url_defaults_to_base(monkeypatch):
    monkeypatch.setenv("SECRET_KEY", "k")
    monkeypatch.setenv("FERNET_KEY", "k")
    monkeypatch.setenv("CSL_BASE_URL", "https://csl.example.com/")
    monkeypatch.delenv("CSL_API_URL", raising=False)
    from app.config import Config

    assert Config().CSL_API_URL == "https://csl.example.com"
