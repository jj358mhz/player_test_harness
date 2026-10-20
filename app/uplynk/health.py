"""How far behind live a channel's newest segment is, from one HLS fetch.

Signed with `pdts=latency`, Uplynk stamps each segment's program date with
encoder time, so the end of the newest segment against the clock says how
old the live edge is. With the default `delay` that's about 30 s; a slicer
that stops sending leaves the playlist frozen and the age keeps growing.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.uplynk.clock import parse_iso

#: Edge age (seconds) above which a channel is "behind" / "stale".
BEHIND_AFTER_S = 90
STALE_AFTER_S = 300

STATUSES = ("ok", "behind", "stale", "error", "unknown")


@dataclass(frozen=True)
class Edge:
    """The newest segment of a media playlist."""

    #: Unix time the newest segment ends (encoder clock), None without dates.
    end: float | None
    segments: int
    media_sequence: int | None
    ended: bool  # #EXT-X-ENDLIST: the stream finished


def playlist_edge(media: str) -> Edge:
    date: float | None = None
    duration: float | None = None
    end: float | None = None
    segments = 0
    sequence = None
    ended = False
    for raw in media.splitlines():
        line = raw.strip()
        if line.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
            try:
                date = parse_iso(line.split(":", 1)[1])
            except ValueError:
                date = None
        elif line.startswith("#EXTINF:"):
            try:
                duration = float(line.split(":", 1)[1].split(",")[0])
            except ValueError:
                duration = None
        elif line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            try:
                sequence = int(line.split(":", 1)[1])
            except ValueError:
                sequence = None
        elif line == "#EXT-X-ENDLIST":
            ended = True
        elif line and not line.startswith("#") and duration is not None:
            segments += 1
            if date is not None:
                date += duration
                end = date
            duration = None
    return Edge(end=end, segments=segments, media_sequence=sequence, ended=ended)


@dataclass(frozen=True)
class Health:
    status: str  # one of STATUSES
    edge_age_s: float | None
    detail: str | None

    @property
    def needs_attention(self) -> bool:
        return self.status in ("behind", "stale", "error")


def assess(ok: bool, error: str | None, media: str | None, now: float) -> Health:
    """A channel's health from one probe (master + first media playlist)."""
    if not ok:
        return Health("error", None, (error or "no manifest")[:300])
    if media is None:
        return Health("error", None, "no media playlist behind the master")
    edge = playlist_edge(media)
    if not edge.segments:
        return Health("error", None, "media playlist has no segments")
    if edge.ended:
        return Health("stale", None, "playlist has ended (#EXT-X-ENDLIST)")
    if edge.end is None:
        return Health("unknown", None, "no program dates to measure against")
    age = now - edge.end
    if age > STALE_AFTER_S:
        return Health("stale", age, f"newest segment is {fmt_age(age)} old")
    if age > BEHIND_AFTER_S:
        return Health("behind", age, f"newest segment is {fmt_age(age)} old")
    return Health("ok", age, None)


def fmt_age(seconds: float) -> str:
    """32 s, 4 m, 2 h 5 m, 3 d 4 h."""
    s = max(0, round(seconds))
    if s < 120:
        return f"{s} s"
    if s < 7200:
        return f"{s // 60} m"
    if s < 2 * 86400:
        return f"{s // 3600} h {s % 3600 // 60} m"
    return f"{s // 86400} d {s % 86400 // 3600} h"
