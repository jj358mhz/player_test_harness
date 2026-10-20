"""Channel health: live-edge age from pdts=latency HLS."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app import autosync
from app.uplynk.clock import parse_iso
from app.uplynk.health import assess, fmt_age, playlist_edge
from app.uplynk.playback import ProbeResult

START = "2026-10-19T12:00:00.000Z"
T0 = parse_iso(START)


def media(segments: int = 3, dates: bool = True, ended: bool = False) -> str:
    lines = ["#EXTM3U", "#EXT-X-TARGETDURATION:5", "#EXT-X-MEDIA-SEQUENCE:100"]
    if dates:
        lines.append(f"#EXT-X-PROGRAM-DATE-TIME:{START}")
    for i in range(segments):
        lines += ["#EXTINF:4.096,", f"seg{i}.ts"]
    if ended:
        lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines)


def test_playlist_edge():
    edge = playlist_edge(media(3))
    assert edge.segments == 3
    assert edge.media_sequence == 100
    assert edge.end == pytest.approx(T0 + 3 * 4.096)
    assert playlist_edge(media(dates=False)).end is None


@pytest.mark.parametrize(
    ("age", "status"),
    [(30, "ok"), (89, "ok"), (120, "behind"), (299, "behind"), (301, "stale"), (4000, "stale")],
)
def test_assess_age(age, status):
    end = T0 + 3 * 4.096
    health = assess(True, None, media(3), now=end + age)
    assert health.status == status
    assert health.edge_age_s == pytest.approx(age)
    assert health.needs_attention == (status != "ok")


def test_assess_failures():
    assert assess(False, "HTTP 400: Non dash asset x", None, 0).status == "error"
    assert assess(False, "HTTP 400: Non dash asset x", None, 0).detail.startswith("HTTP 400")
    assert assess(True, None, None, 0).status == "error"
    assert assess(True, None, media(0), 0).status == "error"
    assert assess(True, None, media(ended=True), 0).status == "stale"
    unknown = assess(True, None, media(dates=False), 0)
    assert (unknown.status, unknown.needs_attention) == ("unknown", False)


def test_fmt_age():
    assert [fmt_age(s) for s in (0, 32.4, 119, 125, 3600, 7300, 412800)] == [
        "0 s",
        "32 s",
        "119 s",
        "2 m",
        "60 m",
        "2 h 1 m",
        "4 d 18 h",
    ]


@pytest.fixture
def channel(make_account, make_channel):
    return make_channel(make_account())


def fresh(probe_calls, age: float = 30):
    """Make the stubbed probe serve a playlist whose edge is `age` s old."""
    body = media(3)
    edge = playlist_edge(body).end
    probe_calls.result = ProbeResult(True, 200, None, 5, "aes-128", "#EXTM3U", None, body)
    return edge + age


def test_check_health_records(app, channel, probe_calls):
    from app.api.service import check_health

    now = fresh(probe_calls, age=400)
    [(ch, health)] = check_health([channel], now=now)
    assert health.status == "stale"
    assert "pdts=latency" in probe_calls[0]
    assert ch.health_status == "stale"
    assert ch.health_edge_s == pytest.approx(400)
    assert ch.health_checked_at is not None
    assert ch.encryption == "aes-128"
    assert ch.needs_attention


def test_dashboard_badge_and_summary(auth_client, channel, probe_calls, monkeypatch):
    from app.api import service

    now = fresh(probe_calls, age=150)
    monkeypatch.setattr(service.time, "time", lambda: now)
    r = auth_client.post("/channels/health", follow_redirects=False)
    assert r.status_code == 302 and "q=attention" in r.headers["Location"]
    page = auth_client.get("/").get_data(as_text=True)
    assert "badge--health--behind" in page
    assert "2 m behind" in page
    assert "1 needs attention" in page
    assert "attention" in page.split('data-search="')[1].split('"')[0]


def test_dashboard_all_ok(auth_client, channel, probe_calls, monkeypatch):
    from app.api import service

    now = fresh(probe_calls, age=31)
    monkeypatch.setattr(service.time, "time", lambda: now)
    r = auth_client.post("/channels/health", follow_redirects=True)
    page = r.get_data(as_text=True)
    assert "all at the live edge" in page
    assert "badge--health--ok" in page and "● 31 s" in page


def test_dashboard_unchecked(auth_client, channel):
    page = auth_client.get("/").get_data(as_text=True)
    assert "not checked yet" in page
    assert "badge--health" not in page.split("channel-card")[1]


def test_run_health_interval(app, channel, probe_calls):
    fresh(probe_calls)
    now = datetime(2026, 10, 19, 12, tzinfo=UTC)
    last = autosync.run_health(app, None, now=now)
    assert last == now and len(probe_calls) == 1
    # Not due yet: nothing probed, time kept.
    assert autosync.run_health(app, last, now=now + timedelta(minutes=5)) == now
    assert len(probe_calls) == 1
    later = now + timedelta(minutes=10)
    assert autosync.run_health(app, last, now=later) == later
    assert len(probe_calls) == 2
    app.config["CHANNEL_HEALTH_INTERVAL"] = 0
    assert autosync.run_health(app, None, now=later) is None


def test_health_alone_starts_the_thread(app, monkeypatch):
    app.config["CHANNEL_SYNC_INTERVAL"] = 0
    monkeypatch.setattr(autosync, "_started", False)
    started = []
    monkeypatch.setattr(autosync.threading, "Thread", lambda **kw: started.append(kw) or _Dummy())
    assert autosync.start(app) is not None
    assert started


class _Dummy:
    def start(self):
        pass


def test_cli(app, channel, probe_calls, monkeypatch):
    from app.api import service

    now = fresh(probe_calls, age=500)
    monkeypatch.setattr(service.time, "time", lambda: now)
    result = app.test_cli_runner().invoke(args=["check-health"])
    assert result.exit_code == 0, result.output
    assert "stale" in result.output and "1 stale" in result.output
