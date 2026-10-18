"""Tests for the player engine version menu."""

from __future__ import annotations

import pytest

from app import engines
from app.engines import Release, latest_patch_per_minor, parse_registry
from tests.conftest import FakeResponse, FakeSession

REGISTRY = {
    "versions": {
        "1.4.14": {},
        "1.5.19": {},
        "1.5.20": {},
        "1.6.18": {},
        "1.6.19": {},
        "1.7.0": {},
        "1.7.3": {},
        "1.7.4-0.canary.1": {},
        "1.7.0-rc.3": {},
        "1.6.20": {"deprecated": "broken"},
    },
    "time": {"1.7.3": "2026-09-11T10:00:00Z", "1.6.19": "2026-08-19T00:00:00Z"},
}


@pytest.fixture(autouse=True)
def _clear_cache():
    engines.clear_cache()
    yield
    engines.clear_cache()


def test_latest_patch_of_last_three_minors():
    picked = latest_patch_per_minor(parse_registry(REGISTRY))
    assert [r.version for r in picked] == ["1.7.3", "1.6.19", "1.5.20"]


def test_patch_ordering_is_numeric():
    picked = latest_patch_per_minor([Release("1.6.9", None), Release("1.6.10", None)], lines=1)
    assert picked[0].version == "1.6.10"


def test_engine_versions_entries_and_cache():
    session = FakeSession(FakeResponse(200, REGISTRY))
    entries = engines.engine_versions("hls.js", session=session, now=1000)
    assert entries[0] == {
        "version": "1.7.3",
        "released": "2026-09-11",
        "notes_url": "https://github.com/video-dev/hls.js/releases/tag/v1.7.3",
    }
    engines.engine_versions("hls.js", session=session, now=2000)
    assert len(session.calls) == 1  # cached
    engines.engine_versions("hls.js", session=session, now=1000 + engines.CACHE_SECONDS + 1)
    assert len(session.calls) == 2  # refreshed


def test_engine_versions_serves_stale_on_failure():
    engines.engine_versions("hls.js", session=FakeSession(FakeResponse(200, REGISTRY)), now=0)
    import requests

    stale = engines.engine_versions(
        "hls.js", session=FakeSession(requests.ConnectionError("down")), now=10**9
    )
    assert stale[0]["version"] == "1.7.3"


def test_unknown_engine_rejected():
    with pytest.raises(engines.EngineVersionsError):
        engines.engine_versions("left-pad")


def test_versions_endpoint(auth_client, monkeypatch):
    monkeypatch.setattr(
        "app.api.routes.list_engine_versions", lambda package: [{"version": "1.7.3"}]
    )
    data = auth_client.get("/api/engines/hls.js/versions").get_json()
    assert data == {"package": "hls.js", "versions": [{"version": "1.7.3"}]}


def test_versions_endpoint_error(auth_client):
    response = auth_client.get("/api/engines/left-pad/versions")
    assert response.status_code == 502
    assert "Unknown engine" in response.get_json()["error"]
