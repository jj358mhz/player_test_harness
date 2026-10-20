"""Channel health over time: sparklines and status streaks (dashboard).

Charts are inline SVG drawn on the server from `ChannelHealthCheck` rows,
so the dashboard needs no script for them. The y axis is the live edge's
age (seconds); stale and erroring checks are marked in red, behind in
amber, and gaps in checking leave gaps in the line.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from markupsafe import Markup

from app.models import ChannelHealthCheck, db
from app.uplynk.health import BEHIND_AFTER_S, STALE_AFTER_S

#: A line breaks where two checks are further apart than this.
GAP = timedelta(minutes=35)
#: The y axis tops out at the larger of this and the window's worst age, up to CAP.
FLOOR_S = 120
CAP_S = 900

MARK_COLOURS = {"behind": "#fcd34d", "stale": "#f87171", "error": "#f87171", "unknown": "#9ca3af"}


@dataclass(frozen=True)
class Point:
    at: datetime  # UTC
    status: str
    edge_s: float | None


def utc(value: datetime) -> datetime:
    """SQLite hands back naive datetimes; they were written as UTC."""
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def history(channel_ids: list[int], since: datetime) -> dict[int, list[Point]]:
    """Checks per channel since `since`, oldest first."""
    out: dict[int, list[Point]] = {cid: [] for cid in channel_ids}
    if not channel_ids:
        return out
    rows = (
        db.session.query(ChannelHealthCheck)
        .filter(
            ChannelHealthCheck.channel_id.in_(channel_ids),
            ChannelHealthCheck.checked_at >= since,
        )
        .order_by(ChannelHealthCheck.checked_at)
        .all()
    )
    for row in rows:
        out[row.channel_id].append(Point(utc(row.checked_at), row.status, row.edge_s))
    return out


def streak_start(points: list[Point]) -> datetime | None:
    """When the latest status began (within the points we have)."""
    if not points:
        return None
    status = points[-1].status
    start = points[-1].at
    for point in reversed(points):
        if point.status != status:
            break
        start = point.at
    return start


@dataclass(frozen=True)
class Change:
    at: datetime
    status: str
    edge_s: float | None
    lasted: timedelta | None  # None for the current status


def changes(points: list[Point], now: datetime) -> list[Change]:
    """Each status change, newest first, with how long it lasted."""
    starts: list[Point] = []
    for point in points:
        if not starts or point.status != starts[-1].status:
            starts.append(point)
    out = []
    for i, point in enumerate(starts):
        end = starts[i + 1].at if i + 1 < len(starts) else None
        out.append(
            Change(point.at, point.status, point.edge_s, None if end is None else end - point.at)
        )
    return out[::-1]


def sparkline(
    points: list[Point],
    start: datetime,
    end: datetime,
    width: int = 160,
    height: int = 28,
    axis: bool = False,
) -> Markup:
    """An inline SVG of edge age over [start, end]; empty string with no points."""
    if not points:
        return Markup("")
    pad_left = 40 if axis else 1
    pad_top = 8 if axis else 1
    pad_bottom = 14 if axis else 1
    plot_w = width - pad_left - 1
    plot_h = height - pad_bottom - pad_top
    ages = [p.edge_s for p in points if p.edge_s is not None]
    top = min(CAP_S, max([FLOOR_S, *ages])) if ages else FLOOR_S
    span = (end - start).total_seconds() or 1

    def x(at: datetime) -> float:
        return pad_left + max(0.0, min(1.0, (at - start).total_seconds() / span)) * plot_w

    def y(age: float) -> float:
        return pad_top + plot_h - min(age, top) / top * plot_h

    parts = [
        f'<svg class="health-spark" viewBox="0 0 {width} {height}" width="{width}" '
        f'height="{height}" role="img" aria-label="Live-edge age over time">'
    ]
    for limit, colour in ((BEHIND_AFTER_S, "#fcd34d"), (STALE_AFTER_S, "#f87171")):
        if limit < top:
            parts.append(
                f'<line x1="{pad_left}" x2="{width - 1}" y1="{y(limit):.1f}" y2="{y(limit):.1f}" '
                f'stroke="{colour}" stroke-opacity=".35" stroke-dasharray="2 3"/>'
            )
    if axis:
        parts.append(_axis(start, end, x, y, top, pad_left, height, width))
    # The line: runs of checks with an age, broken at gaps.
    run: list[str] = []
    runs: list[list[str]] = []
    previous: Point | None = None
    for point in points:
        if point.edge_s is None or (previous and point.at - previous.at > GAP):
            if len(run) > 1:
                runs.append(run)
            run = []
        if point.edge_s is not None:
            run.append(f"{x(point.at):.1f},{y(point.edge_s):.1f}")
        previous = point
    if len(run) > 1:
        runs.append(run)
    for r in runs:
        parts.append(
            f'<polyline points="{" ".join(r)}" fill="none" stroke="#86efac" '
            'stroke-width="1.5" stroke-linejoin="round"/>'
        )
    # Marks for anything not ok (errors and no-date checks sit on the baseline).
    for point in points:
        colour = MARK_COLOURS.get(point.status)
        if colour is None:
            continue
        cy = y(point.edge_s) if point.edge_s is not None else pad_top + plot_h - 1.5
        parts.append(f'<circle cx="{x(point.at):.1f}" cy="{cy:.1f}" r="1.8" fill="{colour}"/>')
    if len(points) == 1 and points[0].edge_s is not None and points[0].status == "ok":
        p = points[0]
        parts.append(f'<circle cx="{x(p.at):.1f}" cy="{y(p.edge_s):.1f}" r="1.8" fill="#86efac"/>')
    parts.append("</svg>")
    return Markup("".join(parts))


def _axis(start, end, x, y, top, pad_left, height, width) -> str:
    """Seconds on the left; a label per day (or every 6 h within a day) underneath."""
    parts = []
    for value in (0, top / 2, top):
        parts.append(
            f'<text x="{pad_left - 4}" y="{y(value) + 3:.1f}" text-anchor="end" '
            f'class="health-spark__label">{round(value)} s</text>'
        )
    step = timedelta(hours=6) if end - start <= timedelta(days=1) else timedelta(days=1)
    tick = start.replace(minute=0, second=0, microsecond=0)
    if step == timedelta(days=1):
        tick = tick.replace(hour=0)
    while tick <= end:
        if tick >= start:
            label = tick.strftime("%H:%M") if step < timedelta(days=1) else tick.strftime("%b %d")
            if tick + step > end:
                label += " UTC"
            # Keep labels inside the chart at either end.
            at = x(tick)
            anchor = "end" if at > width - 40 else "start" if at < pad_left + 20 else "middle"
            parts.append(
                f'<text x="{at:.1f}" y="{height - 2}" text-anchor="{anchor}" '
                f'class="health-spark__label">{label}</text>'
            )
        tick += step
    return "".join(parts)
