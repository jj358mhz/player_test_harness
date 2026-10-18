"""Put Uplynk DASH on the encoder's clock.

Uplynk synthesises each live MPD's clock: `availabilityStartTime` is chosen
so the newest segment ends about now, whatever the real delay. Players then
report latency against that clock and under-read by the real age of the
edge (about 30 s with the default `delay`). `pdts` doesn't change the MPD.

HLS signed with `pdts=latency` stamps segments with encoder time, and its
`#UPLYNK-SEGMENT: <asset>,<hex slice>,<kind>` slices are the MPD's
`$Number$` within the Period whose `AssetIdentifier` is that asset. Find a
slice in both and the difference of their start times is how far the MPD
clock runs ahead: real latency = MPD-clock latency + offset.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime

_DASH_NS = "{urn:mpeg:dash:schema:mpd:2011}"
_ASSET_SCHEME = "urn:org:dashif:asset-id:2013"
#: How far apart (in slices) the two windows may be before we stop counting across.
MAX_EXTRAPOLATED_SLICES = 60
_DURATION = re.compile(
    r"^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$"
)


@dataclass(frozen=True)
class Slice:
    asset: str
    number: int
    start: float  # unix seconds
    duration: float


def parse_iso(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def parse_duration(value: str | None) -> float:
    """ISO 8601 duration as used in MPDs (PT24272.896S, PT1H2M)."""
    match = _DURATION.match(value or "")
    if not match or not value or value == "P":
        return 0.0
    d, h, m, s = (float(g) if g else 0.0 for g in match.groups())
    return d * 86400 + h * 3600 + m * 60 + s


def hls_slices(playlist: str) -> list[Slice]:
    """Slices of an HLS media playlist with their program dates.

    Only segments after an `#EXT-X-PROGRAM-DATE-TIME` and an
    `#UPLYNK-SEGMENT` tag are returned; numbers count up from the tag.
    """
    out: list[Slice] = []
    asset: str | None = None
    number = 0
    date: float | None = None
    duration: float | None = None
    for raw in playlist.splitlines():
        line = raw.strip()
        if line.startswith("#UPLYNK-SEGMENT:"):
            parts = [p.strip() for p in line.split(":", 1)[1].split(",")]
            if len(parts) >= 2:
                try:
                    asset, number = parts[0], int(parts[1], 16)
                except ValueError:
                    asset = None
        elif line.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
            try:
                date = parse_iso(line.split(":", 1)[1])
            except ValueError:
                date = None
        elif line.startswith("#EXTINF:"):
            try:
                duration = float(line.split(":", 1)[1].split(",")[0])
            except ValueError:
                duration = None
        elif line and not line.startswith("#"):
            if duration is not None:
                if asset is not None and date is not None:
                    out.append(Slice(asset, number, date, duration))
                    number += 1
                if date is not None:
                    date += duration
            duration = None
    return out


def mpd_slices(mpd: str) -> list[Slice]:
    """Video segments of a dynamic MPD, timed on the MPD's own clock."""
    try:
        root = ET.fromstring(mpd)
    except ET.ParseError:
        return []
    ast = root.get("availabilityStartTime")
    if root.get("type") != "dynamic" or not ast:
        return []
    try:
        anchor = parse_iso(ast)
    except ValueError:
        return []
    out: list[Slice] = []
    for period in root.findall(f"{_DASH_NS}Period"):
        asset = next(
            (
                a.get("value")
                for a in period.findall(f"{_DASH_NS}AssetIdentifier")
                if a.get("schemeIdUri") == _ASSET_SCHEME
            ),
            None,
        )
        template = _video_template(period)
        if asset is None or template is None:
            continue
        timescale = float(template.get("timescale") or 1)
        offset = int(template.get("presentationTimeOffset") or 0)
        number = int(template.get("startNumber") or 1)
        base = anchor + parse_duration(period.get("start"))
        timeline = template.find(f"{_DASH_NS}SegmentTimeline")
        t = 0
        for s in timeline.findall(f"{_DASH_NS}S") if timeline is not None else []:
            t = int(s.get("t", t))
            d = int(s.get("d") or 0)
            for _ in range(int(s.get("r") or 0) + 1):
                out.append(Slice(asset, number, base + (t - offset) / timescale, d / timescale))
                t += d
                number += 1
    return out


def _video_template(period: ET.Element) -> ET.Element | None:
    for adaptation in period.findall(f"{_DASH_NS}AdaptationSet"):
        kind = adaptation.get("contentType") or adaptation.get("mimeType", "")
        if not kind.startswith("video"):
            continue
        template = adaptation.find(f"{_DASH_NS}SegmentTemplate")
        if template is None:
            rep = adaptation.find(f"{_DASH_NS}Representation")
            template = rep.find(f"{_DASH_NS}SegmentTemplate") if rep is not None else None
        if template is not None:
            return template
    return None


@dataclass(frozen=True)
class DashClock:
    """How far an MPD's clock runs ahead of the encoder's."""

    offset_s: float
    #: Real age of the MPD's newest segment end when it was fetched.
    edge_age_s: float | None
    slice: str  # "#<number>", the slice the two were matched on

    def as_dict(self) -> dict[str, object]:
        return {
            "offset_s": round(self.offset_s, 2),
            "edge_age_s": None if self.edge_age_s is None else round(self.edge_age_s, 1),
            "reference": "pdts=latency",
            "slice": self.slice,
        }


def dash_clock(mpd: str, reference_hls: str, fetched_at: float | None = None) -> DashClock | None:
    """Offset between an MPD's clock and `pdts=latency` HLS, or None if no slice matches."""
    hls = hls_slices(reference_hls)
    dash = mpd_slices(mpd)
    if not hls or not dash:
        return None
    real = {(s.asset, s.number): s for s in hls}
    offset = None
    for s in reversed(dash):  # prefer the newest shared slice
        match = real.get((s.asset, s.number))
        if match is not None:
            offset, label = s.start - match.start, f"#{s.number}"
            break
    if offset is None:
        # Windows don't overlap (fetched apart, or a different delay): within
        # one asset, slices are back to back, so count across the gap.
        s = dash[-1]
        same = [h for h in hls if h.asset == s.asset]
        if not same:
            return None
        near = min(same, key=lambda h: abs(h.number - s.number))
        if abs(near.number - s.number) > MAX_EXTRAPOLATED_SLICES:
            return None
        offset = s.start - (near.start + (s.number - near.number) * near.duration)
        label = f"#{s.number} (counted from #{near.number})"
    edge = dash[-1].start + dash[-1].duration - offset
    return DashClock(
        offset_s=offset,
        edge_age_s=None if fetched_at is None else fetched_at - edge,
        slice=label,
    )
