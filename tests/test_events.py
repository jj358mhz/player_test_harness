"""Live events: the api2 list client, event sync, playback and the dashboard tab."""

from __future__ import annotations

import base64
import json
import zlib
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qsl, urlsplit

import pytest

from app.models import Channel, UplynkAccount, db
from app.uplynk import sync as sync_module
from app.uplynk.channels import UplynkAPIError
from app.uplynk.events import PAGE_LIMIT, DiscoveredEvent, UplynkEventsClient
from tests.conftest import FakeResponse, FakeSession

START = datetime(2026, 10, 30, 12, tzinfo=UTC)
MS = int(START.timestamp() * 1000)


def _item(event_id, **kwargs):
    return {"id": event_id, "desc": f"Event {event_id}", **kwargs}


def _msg_body(call):
    """The JSON body classic v2 auth signs into `msg`."""
    _, kwargs = call
    return json.loads(zlib.decompress(base64.b64decode(kwargs["params"]["msg"])))


def _client(responses):
    session = FakeSession(responses)
    client = UplynkEventsClient(
        "https://services.example.com", "owner123", "secret-api-key", session=session
    )
    return client, session


# ---- Client ---------------------------------------------------------------


def test_list_signs_params_into_msg_and_parses_events():
    client, session = _client(
        FakeResponse(
            payload={
                "error": 0,
                "events": [
                    _item(
                        "evt0001",
                        external_id="ext1",
                        state="ready",
                        expected_start=MS,
                        expected_stop=MS + 3_600_000,
                        actual_start=0,
                        slicers=[{"owner": "owner123", "id": "slicer01"}],
                        require_studio_drm=True,
                    ),
                    _item("evt0002", deleted=1),
                ],
            }
        )
    )
    events = client.list_events(START, START + timedelta(days=1))

    assert [e.event_id for e in events] == ["evt0001"]  # deleted one skipped
    event = events[0]
    assert event.external_id == "ext1" and event.state == "ready"
    assert event.slicer_id == "slicer01" and event.require_drm
    assert event.expected_start == START
    assert event.expected_stop == START + timedelta(hours=1)
    assert event.actual_start is None and event.actual_stop is None

    url, kwargs = session.calls[0]
    assert url == "https://services.example.com/api2/liveevents2/list"
    assert set(kwargs["params"]) == {"msg", "sig"}
    body = _msg_body(session.calls[0])
    assert body["_owner"] == "owner123"
    assert body["start"] == MS and body["stop"] == MS + 86_400_000
    assert body["limit"] == PAGE_LIMIT and body["skip"] == 0


def test_list_pages_until_a_short_page():
    full = FakeResponse(payload={"error": 0, "events": [_item(f"e{i}") for i in range(PAGE_LIMIT)]})
    last = FakeResponse(payload={"error": 0, "events": [_item("last")]})
    client, session = _client([full, last])
    events = client.list_events(START, START + timedelta(days=1))
    assert len(events) == PAGE_LIMIT + 1
    assert [_msg_body(c)["skip"] for c in session.calls] == [0, PAGE_LIMIT]


@pytest.mark.parametrize(
    "response, message",
    [
        (FakeResponse(403, text="no"), r"refused the live events list \(403\)"),
        (FakeResponse(500, text="boom"), "HTTP 500"),
        (FakeResponse(payload={"error": 1, "msg": "bad owner"}), "bad owner"),
        (FakeResponse(payload={"error": 0}), "no 'events' list"),
        (FakeResponse(payload={"error": 0, "events": [{"desc": "no id"}]}), "missing an id"),
    ],
)
def test_list_errors(response, message):
    client, _ = _client(response)
    with pytest.raises(UplynkAPIError, match=message):
        client.list_events(START, START + timedelta(days=1))


def test_times_accept_seconds_and_ignore_junk():
    event = DiscoveredEvent.from_api(
        _item("e1", expected_start=int(START.timestamp()), actual_start=None, actual_stop=True)
    )
    assert event.expected_start == START
    assert event.actual_start is None and event.actual_stop is None


# ---- Sync -----------------------------------------------------------------


class StubChannels:
    auth_mode = "classic"

    def list_channels(self):
        return []

    def list_ad_servers(self):
        return []


@pytest.fixture
def stub_events(monkeypatch):
    """Stub both clients; returns a dict whose 'events' (or 'error') the sync gets."""
    answer = {"events": [], "error": None, "windows": []}
    monkeypatch.setattr(sync_module, "build_client", lambda account: StubChannels())

    class Stub:
        def __init__(self, **kwargs):
            pass

        def list_events(self, start, stop):
            answer["windows"].append((start, stop))
            if answer["error"]:
                raise answer["error"]
            return answer["events"]

    monkeypatch.setattr(sync_module, "UplynkEventsClient", Stub)
    return answer


def _de(event_id, **kwargs):
    defaults = dict(
        external_id=None,
        description=f"Event {event_id}",
        state=None,
        slicer_id=None,
        expected_start=START,
        expected_stop=None,
        actual_start=None,
        actual_stop=None,
        require_drm=False,
    )
    defaults.update(kwargs)
    return DiscoveredEvent(event_id=event_id, **defaults)


def test_sync_skips_events_unless_enabled(app, make_account, stub_events):
    acct = make_account()
    result = sync_module.sync_account(acct)
    assert result.events is None and stub_events["windows"] == []


def test_sync_events_creates_updates_and_deactivates(app, make_account, make_channel, stub_events):
    acct = make_account(sync_events=True)
    channel = make_channel(acct, "chan0001")
    kept = make_channel(acct, "evt0001", kind="event", is_favorite=True)  # pre-event until now
    make_channel(acct, "evt0002", kind="event")
    make_channel(acct, "evt0004", kind="event")
    stub_events["events"] = [
        _de("evt0001", description="Renamed", actual_start=START, require_drm=True),
        _de("evt0003"),
        # Ended: listed by Uplynk (in the window) but not kept.
        _de("evt0004", actual_start=START, actual_stop=START + timedelta(hours=4)),
        _de("evt0005", actual_start=START, actual_stop=START + timedelta(hours=4)),
    ]

    result = sync_module.sync_account(acct)

    assert result.error is None and result.event_error is None
    assert (result.events.created, result.events.updated, result.events.deactivated) == (1, 1, 2)
    assert "events: 1 new, 1 updated, 2 gone, 1 went live" in result.summary
    assert not db.session.query(Channel).filter_by(channel_id="evt0004").one().is_active
    assert db.session.query(Channel).filter_by(channel_id="evt0005").first() is None
    db.session.refresh(kept)
    assert kept.description == "Renamed" and kept.is_favorite and kept.is_drm
    assert kept.event_phase == "live" and kept.content_type == "e"
    new = db.session.query(Channel).filter_by(channel_id="evt0003").one()
    assert new.kind == "event" and new.event_phase == "pre"
    assert not db.session.query(Channel).filter_by(channel_id="evt0002").one().is_active
    # Channel sync doesn't deactivate events, and event sync leaves channels alone.
    db.session.refresh(channel)
    assert channel.is_active is False  # missing from the (empty) channel list
    assert kept.is_active

    ((start, stop),) = stub_events["windows"]
    assert stop - start == timedelta(hours=24) + timedelta(days=7)


def test_event_failure_does_not_fail_the_channel_sync(app, make_account, stub_events):
    acct = make_account(sync_events=True)
    stub_events["error"] = UplynkAPIError("Uplynk API error: nope")
    result = sync_module.sync_account(acct)
    assert result.error is None
    assert "live events not synced: Uplynk API error: nope" in result.summary
    assert db.session.get(UplynkAccount, acct.id).last_sync_error is None


def test_turning_sync_off_deactivates_events(app, make_account, make_channel, stub_events):
    acct = make_account()
    event = make_channel(acct, "evt0001", kind="event")
    sync_module.sync_account(acct)
    db.session.refresh(event)
    assert not event.is_active


def test_checkable_skips_events_off_air(app, make_account, make_channel):
    acct = make_account()
    make_channel(acct, "chan0001")
    make_channel(acct, "evt-pre", kind="event")
    make_channel(acct, "evt-live", kind="event", actual_start=START)
    make_channel(acct, "evt-done", kind="event", actual_start=START, actual_stop=START)
    ids = {c.channel_id for c in db.session.query(Channel).filter(Channel.checkable())}
    assert ids == {"chan0001", "evt-live"}


# ---- Playback and pages -----------------------------------------------------


def test_event_signs_event_url(auth_client, make_account, make_channel):
    event = make_channel(make_account(), "evt0001", kind="event")
    response = auth_client.post("/api/playback", json={"channel_id": event.id, "manifest": "mpd"})
    assert response.status_code == 200
    parts = urlsplit(response.get_json()["url"])
    assert parts.path == "/event/evt0001.mpd"
    params = dict(parse_qsl(parts.query))
    assert params["ct"] == "e" and params["cid"] == "evt0001"


def test_event_preplay_uses_the_event_endpoint(
    auth_client, make_account, make_channel, monkeypatch
):
    from app.api import service
    from app.uplynk.playback import PreplayResult

    fetched = []

    def fake_preplay(url):
        fetched.append(url)
        return PreplayResult(
            play_url="https://content-x.example.com/preplay2/event/evt0001/abc/def.mpd",
            prefix="https://content-x.example.com",
            sid="sid1",
            drm={"required": True, "widevineLicenseURL": "https://content-x.example.com/wv"},
            raw={},
        )

    monkeypatch.setattr(service, "fetch_preplay", fake_preplay)
    event = make_channel(make_account(), "evt0001", kind="event")
    response = auth_client.post(
        "/api/playback",
        json={"channel_id": event.id, "manifest": "mpd", "mode": "preplay", "drm": "wv"},
    )
    assert response.status_code == 200, response.get_json()
    parts = urlsplit(fetched[0])
    assert parts.path == "/preplay/event/evt0001.json"
    params = dict(parse_qsl(parts.query))
    assert params["ct"] == "e" and params["rmt"] == "wv" and params["manifest"] == "mpd"
    body = response.get_json()
    assert body["url"].endswith("/def.mpd")
    assert body["drm_config"]["widevineLicenseURL"] == "https://content-x.example.com/wv"


EVENTS_LINK = 'href="/events" class="site-header__link"'


def test_events_page(auth_client, make_account, make_channel):
    acct = make_account(sync_events=True)
    make_channel(acct, "chan0001", description="A channel")
    make_channel(acct, "evt0001", kind="event", description="Big game", expected_start=START)

    page = auth_client.get("/").get_data(as_text=True)
    assert "A channel" in page and "Big game" not in page
    assert EVENTS_LINK in page  # in the header, on every page

    page = auth_client.get("/events").get_data(as_text=True)
    assert "Big game" in page and "A channel" not in page
    assert "<h1>Events" in page
    assert "Pre-event" in page and "2026-10-30 12:00 UTC" in page
    assert 'data-section="events:demo"' in page

    # v3.33's tab links still land there.
    assert auth_client.get("/?tab=events").headers["Location"].endswith("/events")


def test_no_events_page_without_events(auth_client, make_account, make_channel):
    make_channel(make_account(), "chan0001")
    page = auth_client.get("/").get_data(as_text=True)
    assert EVENTS_LINK not in page
    assert auth_client.get("/events").headers["Location"].endswith("/")


def test_player_config_marks_events(app, make_account, make_channel):
    # The options directly: /player renders them only once the frontend is built.
    from app.main.routes import _channel_options

    acct = make_account()
    make_channel(acct, "chan0001")
    make_channel(acct, "evt0001", kind="event", actual_start=START, expected_start=START)
    with app.test_request_context():
        options = {o["channelId"]: o for o in _channel_options()}
    assert "kind" not in options["chan0001"]
    assert options["evt0001"]["kind"] == "event"
    assert options["evt0001"]["phase"] == "live"
    assert options["evt0001"]["expectedStart"] == START.isoformat()


def test_account_form_saves_sync_events(auth_client, make_account):
    acct = make_account()
    response = auth_client.post(
        f"/admin/uplynk-accounts/{acct.id}/edit",
        data={"label": "demo", "workspace_id": "owner123", "sync_events": "y"},
    )
    assert response.status_code == 302
    assert db.session.get(UplynkAccount, acct.id).sync_events is True
    page = auth_client.get(f"/admin/uplynk-accounts/{acct.id}/edit").get_data(as_text=True)
    assert "Sync live events" in page
