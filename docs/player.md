# Player reference

The monitoring player at `/player` (source: `frontend/src`). It plays a
synced channel (signed server-side) or any pasted URL, and shows what an
Uplynk stream is doing while it plays.

## Layout

- **Load bar:** channel or pasted URL, format (HLS or DASH), player engine
  and version, DRM, Load.
  `?channel=<id>` or `?src=<url>` in the address loads on open.
- **Status chips:** live/VOD, engine version, encryption, codecs, rays,
  and time left on the playback token.
- **Video** with the current ray and latency overlaid.
- **Vitals:** latency, live-edge drift, buffer, ray, rebuffers, errors. The
  coloured top edge shows state.
- **Timeline (last 5 minutes):** latency (solid) and live-edge drift
  (dashed) on one seconds scale, with current values at the right; ray
  switches, key/license loads, SCTE-35 cues, discontinuities and errors in
  the lane below. Ad breaks are shaded. Latency rising *with* drift means
  the player is falling behind the edge; rising while drift stays flat means
  the stream itself is arriving late.
- **Inspector tabs** (deep-link with `#latency`, `#abr`, `#keys`, `#meta`,
  `#tracks`, `#manifest`, `#network`, `#log`).

## Compatibility

The **Compatibility** panel under the load bar checks what this browser can
do (HTTPS, MSE, native HLS, Widevine L1/L3, PlayReady, FairPlay, ClearKey),
shows which browser plays which format and DRM, and explains how Uplynk's
Studio DRM maps onto them. It remembers whether you left it open.

## Latency

All three are measured at the playhead, once a second:

| Measure | What it is |
|---|---|
| **ID3 wallclock** | The encoder's timestamp in the segment's ID3 TXXX frame, carried forward to the frame on screen: `now − (wallclock + (currentTime − sample time))`. Needs `wallclock` enabled on the slicer. |
| **Program date-time** | `#EXT-X-PROGRAM-DATE-TIME` at the playhead (`hls.playingDate`) to now. |
| **Live-edge drift** | Playhead to the live edge of the playlist (`hls.latency`), with the engine's target shown alongside. |

The headline number is ID3 when the stream has it, otherwise PDT. The
Current / Average / Max / Min tiles run from load and use these bands:
Awesome <10 s, Good 10–19 s, Average 19–25 s, Above avg 25–40 s, Yuk >40 s.

**Auto-sync** jumps to live when drift passes a limit (at most every 10 s).
**Tab return** does the same when you come back to the tab.

The original player measured ID3 latency when each segment downloaded, so
it read higher by roughly the buffer length.

## Rays (ABR tab)

Renditions are labelled by Uplynk ray (`a` = lowest), read from each
variant URI (`…/e.m3u8`), with resolution, frame rate and profile from
`#UPLYNK-MEDIA0`. Toggle rays and **Re-sign & reload** to play the channel
with `rays=` (synced channels only). The tab also shows estimated
bandwidth, switches, the last segment and dropped frames.

## DRM & keys

**Studio DRM** channels: choose **DRM → Widevine** (or PlayReady on Edge).
The player switches to DASH and Shaka (or dash.js, if that's the chosen
engine), signs a Preplay v2 session with
`rmt=wv`, and uses the session's license URL. The tab shows:

- key system, license server, robustness and license expiry;
- license requests: count, average and last time, failures (also on the
  timeline and in the waterfall);
- **key status** per key id — `usable`, or problems such as
  `output-restricted` (HDCP / output protection) with a hint;
- DRM errors with a plain-language explanation of the Shaka error code.

Plain signed HLS of a Studio DRM channel is **FairPlay**, which only Safari
can decrypt. Channels known to be DRM show 🔒 in the channel picker (and a
🔒 DRM badge on the dashboard); outside Safari the player selects
**Widevine** for them automatically. A channel not yet known to be DRM is
detected on first play (its media playlist carries FairPlay keys) and
replayed as Widevine; for a pasted URL the player offers **Play with
Widevine (DASH)** instead. FairPlay playback in Safari is still to come.

For AES-128 HLS the tab shows the encryption method, keys seen and key load
time. Uplynk key URIs include the ray (`r=`), so the same key on another
ray isn't counted as a rotation.

## Metadata

ID3 frames as they arrive. **SCTE-35** in ID3 PRIV frames (and in
`#EXT-X-DATERANGE` `SCTE35-OUT/IN/CMD`) is decoded — `splice_insert`,
`time_signal` and segmentation descriptors (type, duration, UPID) — and
acted on when the cue reaches the playhead: an out cue opens an ad break on
the timeline, an in cue closes it, and a break with a planned duration
closes itself if no in cue arrives. Uplynk's `#UPLYNK-SEGMENT` tags show
the asset at the playhead and its kind; an `ad` asset also opens a break.

## Tracks

Audio tracks (switchable), caption and subtitle tracks including in-band
CEA-608 (switchable, with the latest cue text and a cue log), and an
**audio level meter**: L/R dBFS from the decoded audio, with **Listen** to
hear it. Silence below −60 dBFS for over 5 s is logged and marked on the
timeline.

## Manifest

Live/VOD, rays, container (TS or fMP4), target duration, window, media
sequence range and whether there's program date-time. Raw text of the
master and the current media playlist, with `sig=`/`pbs=` values hidden.

## Network

Segment count, average load time, bytes and HTTP errors, plus a
**waterfall** of the last 30 seconds of requests: master, media playlists,
init and media segments and key fetches. Slow segments (over half the
target duration) are orange; failures are red.

## Engines and versions

- **hls.js** plays HLS (clear and AES-128).
- **Shaka Player** plays DASH and HLS, and Widevine/PlayReady.
- **dash.js** plays DASH, and Widevine/PlayReady. Without a DRM setting it
  takes the license URL from the MPD's `<ms:laurl>`: Uplynk DASH is always
  CENC, even on channels without Studio DRM. (Shaka does this by itself.)
  dash.js 5.2 reports every request to the waterfall; older lines report
  fewer.
- **Native** (listed when the browser says it can play HLS) hands the URL
  to the `<video>` element, as Safari does. The browser hides most of its
  work: the ladder and rays come from the harness's own copy of the master
  playlist, the current ray from the decoded frame size, latency from ID3
  cues and `getStartDate()`, requests from Resource Timing where the
  browser reports them. Outside Safari the built-in HLS is often
  incomplete and may refuse the stream (`MEDIA_ERR_SRC_NOT_SUPPORTED`).

The format and engine keep each other valid: DASH picks Shaka unless
dash.js is chosen, HLS picks hls.js unless Shaka or Native is chosen, and
a DRM uses dash.js when it's selected, otherwise Shaka.

For each npm engine, the menu lists the latest patch of the last three minor lines
from npm (refreshed daily) plus a custom exact version. Versions load from
jsDelivr; the defaults are pinned in `frontend/package.json` and kept
current by Dependabot. `playerEngine` in the browser console is the live
engine (e.g. `playerEngine.drmState()`).
