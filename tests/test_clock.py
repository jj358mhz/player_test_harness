"""DASH clock offset: match MPD slices to pdts=latency HLS."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from app.uplynk.clock import dash_clock, hls_slices, mpd_slices, parse_duration

AST = datetime(2026, 1, 1, tzinfo=UTC).timestamp()


def mpd(start_number=10, asset="asset0001", kind="dynamic"):
    return f"""<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="{kind}"
     availabilityStartTime="2026-01-01T00:00:00Z" suggestedPresentationDelay="PT12.288S">
  <Period id="p1" start="PT100S">
    <AssetIdentifier schemeIdUri="urn:org:dashif:asset-id:2013" value="{asset}"/>
    <AdaptationSet contentType="audio"><Representation id="m">
      <SegmentTemplate timescale="48000" startNumber="1"><SegmentTimeline>
        <S t="0" d="196608" r="99"/></SegmentTimeline></SegmentTemplate>
    </Representation></AdaptationSet>
    <AdaptationSet contentType="video"><Representation id="D">
      <SegmentTemplate timescale="90000" presentationTimeOffset="900000"
                       startNumber="{start_number}"><SegmentTimeline>
        <S t="900000" d="368640" r="7"/></SegmentTimeline></SegmentTemplate>
    </Representation></AdaptationSet>
  </Period>
</MPD>"""


def hls(first=14, date="2026-01-01T00:01:26.384Z", asset="asset0001", count=8):
    lines = ["#EXTM3U", "#EXT-X-TARGETDURATION:8", f"#UPLYNK-SEGMENT: {asset},{first:08X},segment"]
    lines.append(f"#EXT-X-PROGRAM-DATE-TIME:{date}")
    for n in range(count):
        lines += ["#EXTINF:4.0960,", f"https://cdn.example.com/D{first + n:08X}.ts"]
    return "\n".join(lines)


def test_parse_duration():
    assert parse_duration("PT24272.896S") == pytest.approx(24272.896)
    assert parse_duration("PT1H2M3S") == 3723
    assert parse_duration(None) == 0


def test_slices_from_both_formats():
    dash = mpd_slices(mpd())
    assert [s.number for s in dash] == list(range(10, 18))  # video only
    assert dash[0].start == pytest.approx(AST + 100)
    assert dash[0].duration == pytest.approx(4.096)
    real = hls_slices(hls())
    assert [s.number for s in real] == list(range(14, 22))
    assert real[1].start - real[0].start == pytest.approx(4.096)


def test_offset_from_a_shared_slice():
    # MPD slice 14 starts at AST+100+4*4.096 = 00:01:56.384; HLS says 00:01:26.384.
    clock = dash_clock(mpd(), hls(), fetched_at=AST + 100 + 8 * 4.096 + 1)
    assert clock.offset_s == pytest.approx(30)
    assert clock.edge_age_s == pytest.approx(31)
    assert clock.slice == "#17"


def test_offset_counted_across_a_gap():
    clock = dash_clock(mpd(), hls(first=30, date="2026-01-01T00:02:31.92Z"))
    assert clock.offset_s == pytest.approx(30)
    assert clock.slice == "#17 (counted from #30)"


@pytest.mark.parametrize(
    "dash,ref",
    [
        (mpd(asset="asset0002"), hls()),  # different asset (an ad, say)
        (mpd(kind="static"), hls()),  # VOD
        (mpd(), hls(first=500)),  # too far apart to count across
        (mpd(), "#EXTM3U\n#EXTINF:4,\nx.ts"),  # no pdts / no Uplynk tags
        ("not xml", hls()),
    ],
)
def test_no_offset(dash, ref):
    assert dash_clock(dash, ref) is None


def test_dash_playback_reports_clock(auth_client, make_account, make_channel, probe_calls):
    from app.uplynk.playback import ProbeResult

    ch = make_channel(make_account())
    probe_calls.result = ProbeResult(True, 200, None, 5, None, mpd(), AST + 134)
    probe_calls.media = hls()
    body = auth_client.post(
        "/api/playback", json={"channel_id": ch.id, "manifest": "mpd", "params": {"delay": "20"}}
    ).get_json()
    assert body["clock"]["offset_s"] == pytest.approx(30)
    assert body["clock"]["reference"] == "pdts=latency"
    assert "body" not in body["probe"]
    (reference,) = probe_calls.media_urls
    assert ".m3u8?" in reference and "&pdts=latency&delay=20&sig=" in reference


def test_hls_playback_has_no_clock(auth_client, make_account, make_channel, probe_calls):
    ch = make_channel(make_account())
    body = auth_client.post("/api/playback", json={"channel_id": ch.id}).get_json()
    assert "clock" not in body and probe_calls.media_urls == []
