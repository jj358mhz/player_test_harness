"""Health history: recording, pruning, sparklines, streaks, pages."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.health_history import Point, changes, sparkline, streak_start
from app.models import ChannelHealthCheck, db
from app.uplynk.playback import ProbeResult
from tests.test_health import media, playlist_edge

T = datetime(2026, 10, 19, 12, tzinfo=UTC)


def pts(*specs):
    """(minutes after T, status, age) → points."""
    return [Point(T + timedelta(minutes=m), s, a) for m, s, a in specs]


def test_streak_start():
    assert streak_start([]) is None
    p = pts((0, "ok", 30), (10, "stale", 400), (20, "stale", 1000))
    assert streak_start(p) == T + timedelta(minutes=10)
    assert streak_start(pts((0, "ok", 30), (10, "ok", 31))) == T


def test_changes():
    p = pts((0, "ok", 30), (10, "ok", 31), (20, "error", None), (30, "ok", 29))
    out = changes(p, T + timedelta(minutes=35))
    assert [(c.status, c.lasted) for c in out] == [
        ("ok", None),
        ("error", timedelta(minutes=10)),
        ("ok", timedelta(minutes=20)),
    ]


def test_sparkline_shapes():
    assert sparkline([], T, T + timedelta(hours=1)) == ""
    p = pts(
        (0, "ok", 30), (10, "ok", 32), (20, "behind", 150), (90, "ok", 31), (100, "error", None)
    )
    svg = str(sparkline(p, T, T + timedelta(hours=2)))
    assert svg.startswith("<svg") and svg.endswith("</svg>")
    # The 70-minute gap breaks the line: one run of three points; the lone last ok has no line.
    assert svg.count("<polyline") == 1
    assert svg.count("<circle") == 2  # behind + error marks
    assert "stroke-dasharray" in svg  # the 90 s line (top is 150 s, so no 300 s line)


def test_sparkline_axis_labels():
    p = pts((0, "ok", 30), (60, "ok", 31))
    svg = str(sparkline(p, T, T + timedelta(days=1), 900, 170, axis=True))
    assert "health-spark__label" in svg and "18:00" in svg


@pytest.fixture
def channel(make_account, make_channel):
    return make_channel(make_account())


def serve(probe_calls, age):
    body = media(3)
    probe_calls.result = ProbeResult(True, 200, None, 5, "aes-128", "#EXTM3U", None, body)
    return playlist_edge(body).end + age


def test_checks_are_kept_and_pruned(app, channel, probe_calls):
    from app.api.service import check_health

    old = ChannelHealthCheck(
        channel_id=channel.id, checked_at=datetime.now(UTC) - timedelta(days=8), status="ok"
    )
    db.session.add(old)
    db.session.commit()
    check_health([channel], now=serve(probe_calls, 40))
    check_health([channel], now=serve(probe_calls, 400))
    rows = db.session.query(ChannelHealthCheck).order_by(ChannelHealthCheck.id).all()
    assert [r.status for r in rows] == ["ok", "stale"]  # the 8-day-old row is gone
    assert rows[1].edge_s == pytest.approx(400)


def test_dashboard_sparkline_and_history_page(auth_client, channel, probe_calls):
    from app.api.service import check_health

    check_health([channel], now=serve(probe_calls, 35))
    check_health([channel], now=serve(probe_calls, 500))
    page = auth_client.get("/").get_data(as_text=True)
    assert 'class="health-spark"' in page
    assert f"/channels/{channel.id}/health" in page
    assert "channel-card__since" in page and "data-local" in page

    page = auth_client.get(f"/channels/{channel.id}/health").get_data(as_text=True)
    assert "Last 24 hours" in page and "Last 7 days" in page
    assert page.count("badge--health--") >= 2  # stale (now) and ok rows
    assert "8 m" in page or "500 s" in page or "stale" in page


def test_history_page_empty(auth_client, channel):
    page = auth_client.get(f"/channels/{channel.id}/health").get_data(as_text=True)
    assert "No checks in the last 7 days" in page
    assert auth_client.get("/channels/999/health").status_code == 404


def test_account_delete_takes_history(auth_client, channel, probe_calls):
    from app.api.service import check_health

    check_health([channel], now=serve(probe_calls, 30))
    assert db.session.query(ChannelHealthCheck).count() == 1
    r = auth_client.post(f"/admin/uplynk-accounts/{channel.uplynk_account_id}/delete")
    assert r.status_code in (302, 303)
    db.session.expire_all()
    assert db.session.query(ChannelHealthCheck).count() == 0
