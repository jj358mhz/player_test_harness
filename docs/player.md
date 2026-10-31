# Player reference

The monitoring player at `/player` (source: `frontend/src`). It plays a
synced channel (signed server-side) or any pasted URL, and shows what an
Uplynk stream is doing while it plays.

## Layout

- **Load bar:** preset, channel or pasted URL, format (HLS or DASH), player
  engine and version, DRM, delay, ads, CMCD, Load. The second row holds the
  boxes a choice asks for (**Engine version** for Custom, **Params** for a
  synced channel) on the left, and **Copy link**, **Save session**,
  **Save as preset…** on the right, so the first row never changes height.
- **Live events:** accounts with **Sync live events** list their events
  in the source menu after their channels, as "<account> · Events", with
  the phase (pre-event or live; ended events drop off at the next sync). They play from `/event/<id>.{m3u8,mpd}`
  (token `ct=e`). Preplay doesn't serve events, so with **Widevine** or
  **PlayReady** an event signs its own MPD and uses Uplynk's license host
  (`content.uplynk.com/wv`, `/pr`; the MPD names it too). FairPlay needs
  Preplay's certificate URL, so it can't play an event.
- **Ads (SSAI):** Uplynk inserts ads only when the playback URL names an ad
  configuration (`ad=<name>`); without it there are no ads, and a name the
  workspace doesn't have stops playback. Channel sync lists each account's
  ad configurations from Uplynk (`/api/v4/ads/servers`, undocumented), and
  an admin can add others and default `ad.*` params under **Uplynk Accounts
  → Edit → Ad servers** (params survive syncs; a name Uplynk stops listing
  is kept and marked). **Ads** in the load bar then offers the selected
  channel's account's names (with their type) and signs `ad=<name>` with its
  params. It starts at **None**: nothing picks an ad server for a channel. This load's own `ad.*` params (e.g. `ad.lib=KOR`, or
  `ad.lib=JPN&ad.kv=…`) go in **Params**, signed on top of the account's
  defaults (yours win on a clash). Deep links and presets carry both as
  they are signed (`ad=fw2&ad.lib=KOR&ad.kv=genre:news`), so each variant
  can be a saved preset; a preset's ad server applies only on channels
  whose account has that name.
- **Params:** Uplynk customization params signed into this load, joined
  with `&` (`expand=ad_01,playback_01&ifo=1`). **+ param** lists the
  documented ones for live channels, grouped (General, Ads, Studio DRM) with
  a line on each; picking one adds `key=` (with a typical value) and says
  what it does. `expand=` names parameter expansion sets from the CMS
  (**Parameter Expansion** page; no API lists them), which Uplynk expands
  server-side. Accepted keys: the menu's, plus any `ad.*`, `fp.*`
  (FairPlay, e.g. `fp.hd.hdcp`), `rmp.*` (Widevine) and `pr.*` (PlayReady).
  `ad.*` needs an ad server in **Ads** or an `expand=` set (which can carry
  `ad=`). Keys the player sets itself are refused with where to set them:
  `ad` (Ads), `rays` (ABR tab), `delay` (Delay), `pdts`, CMCD, `ak` and the
  token (`tc`, `exp`, `cid`, `sig`, …). Values are plain characters only.
  Links and presets carry them as themselves. Not for pasted URLs (their
  signature is fixed).
- **Presets:** a named setup of an optional channel, format, engine and
  version, DRM, delay, ads, Uplynk params and CMCD, saved on the server for
  everyone using the harness. Picking one in **Preset** (first in the load
  bar) selects its channel if it names one, and sets the rest of it
  (anything it doesn't name goes back to the default; no DRM means the
  channel's default); press **Load**. A preset without a channel applies
  to whichever channel is selected. **Save as preset…** saves the current
  settings under a name (the same name replaces it); **Include channel**
  (on by default) saves the selected channel with it. The **Presets** page
  in the site menu lists them all in plain words and adds, edits, renames
  and deletes them, with a **Channel** menu (None = any channel); **Open in
  player** opens the player with one chosen (`/player?preset=<id>`) and,
  when it names a channel, plays it.
  The default version of an engine isn't pinned, so a preset follows the
  default when Dependabot bumps it; pick an exact version to pin it.
  Changing a setting by hand (or another channel, for a preset with one)
  clears the Preset menu. Rays and pasted URLs aren't part of a preset.
- **Recorded sessions:** **Save session** sends what this load measured to
  the server and copies a link to `/sessions/<id>`: summary tiles, latency
  and drift over the whole session with events and ad breaks, latency
  stats per source, the ray ladder, request totals by kind (count, failed,
  avg, p95), the last 400 requests, DRM and key status, the log (without
  ID3 noise) and the browser. Signatures, `pbs=` tokens, Preplay session
  paths and license URL queries are removed in the browser and again on the
  server. **Open live** reopens a synced channel with a fresh signature
  (pasted URLs can't be reopened). Kept `SESSION_RETENTION_DAYS` (default
  30); `flask prune-sessions` and every save delete older ones. The
  **Sessions** page lists them.
- **Deep links:** the address bar always describes the view, so it can be
  shared or reloaded: `?channel=<id>` (or `?src=<url>`), `format=dash`,
  `engine=<hlsjs|shaka|dashjs|native>[@<version>]`, `drm=wv|pr`,
  `rays=fed`, `delay=20`, plus the tab as `#latency` etc. Example:
  `/player?channel=12&format=dash&engine=dashjs@5.2.1&drm=wv&rays=fed#keys`.
  Values are checked (exact versions only); a DRM channel still picks
  Widevine itself, so `drm=` is only written when you chose it.
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
- **Buffer & bandwidth** (under the timeline, same time axis): forward
  buffer in seconds (filled) and the engine's ABR bandwidth estimate (line,
  scaled to its own peak), with current values at the right. Stalls are
  shaded red and ad breaks purple, so a buffer draining into a `REBUFFER`
  (segments not arriving) reads differently from a stall with buffer left
  (the player not moving on). It takes any spare height in the panel.
  Saved sessions keep it (v3.31.0) and the replay page draws it.
- **Now** strip: the Uplynk asset on screen (`AD`/`CONTENT`, first 8 hex),
  how long it has been playing, which ad of the break it is and how far
  into the break. Shown once an asset is known (HLS `#UPLYNK-SEGMENT`, DASH
  emsg ID3).
- **Stalls and jumps** in the Log: `REBUFFER` when the buffer runs dry,
  `RESUMED` with how long it stalled, and any time the playhead moves
  without playing through: `GAP JUMP` (out of a stall, or Shaka's
  `gapjumped`/`stalldetected`; also marked on the timeline) with the seconds
  of content skipped, `JUMP TO LIVE` (Jump to live, auto-sync, tab return)
  or `SEEK`. dash.js and hls.js jump gaps silently, so the label comes from
  watching the video element (`lib/jumps.ts`). On DASH a stall also logs
  `MPD @ STALL`: the newest two Periods, how far their listed video
  segments reach, and the playhead against that; repeated whenever a
  refresh changes it during the stall (`lib/mpdTail.ts`).
- **Inspector tabs** (deep-link with `#latency`, `#abr`, `#keys`, `#meta`,
  `#tracks`, `#manifest`, `#network`, `#log`).

## Compatibility

The **Compatibility** panel under the load bar checks what this browser can
do (HTTPS, MSE, native HLS, Widevine L1/L3, PlayReady, FairPlay, ClearKey),
shows which browser plays which format and DRM, and explains how Uplynk's
Studio DRM maps onto them. It remembers whether you left it open.

## Compare

`/compare` puts two players side by side. Pick a **Channel** and a
**Compare** preset and press **Load both**:

| Preset | A | B |
|---|---|---|
| HLS vs DASH | hls.js | Shaka, DASH |
| hls.js vs Shaka | hls.js | Shaka, HLS |
| Shaka vs dash.js | Shaka, DASH | dash.js, DASH |
| Default vs 20 s delay | hls.js | hls.js, `delay=20` |

Each pane is the full player with its own load bar, so anything (engine
version, DRM, rays, delay, even a pasted URL) can differ. The table at the
top reads both panes once a second: latency now/avg/min/max, which clock,
live-edge drift, buffer, ray and bitrate, bandwidth estimate, startup
(engine load to first frame), rebuffers, errors, ray switches and segment
time, with a **B − A** column. The chart draws both latencies on one axis.
For synced channels both are on the encoder clock (see Which clock), so
HLS and DASH numbers compare directly.

**Copy link** gives `/compare?a=<player query>&b=<player query>` (each is
a player deep link). **Save both** saves each pane as a recorded session
and copies both links. Each pane signs its own URL: a DASH URL can only be
fetched once per browser.

## Latency

All three are measured at the playhead, once a second:

| Measure | What it is |
|---|---|
| **Encoder wallclock** | The encoder's time carried in the segments, carried forward to the frame on screen: `now − (wallclock + (currentTime − sample time))`. HLS: the ID3 TXXX frame (needs `wallclock` enabled on the slicer). DASH (Shaka, dash.js): Uplynk's `com.uplynk.asset.metadata` emsg, which carries the same ID3 (so the same `wallclock: 1` rule applies), or a `prft` box in each video segment if the packager writes one (Uplynk doesn't), anchored at the segment's start (`tfdt` and the init's timescale correct for a prft stamped later in the segment); the Metadata tab's **prft** row counts them, or says none were found. |
| **Program date-time** | `#EXT-X-PROGRAM-DATE-TIME` at the playhead (`hls.playingDate`) to now. For DASH, the MPD's clock at the playhead, plus the measured offset (below). |
| **Live-edge drift** | Playhead to the live edge of the playlist (`hls.latency`), with the engine's target shown alongside. |

The headline number is the encoder wallclock (ID3 or prft) when the stream has it, otherwise PDT. The
Current / Average / Max / Min tiles run from load and use these bands:
GOAT <10 s, Awesome 10–19 s, Good 19–25 s, Average 25–45 s, Yuk >45 s.

### Which clock

Program dates are only as good as the clock behind them, and Uplynk's
defaults aren't the encoder's:

- **HLS.** By default each playback session stamps its first slice with
  the time the session started, so latency misses the delay before it
  (about 5 s) and a session that idles falls behind, then catches up when
  polled again. The player signs synced channels with **`pdts=latency`**,
  which stamps slices with encoder time; the Latency tab says **Encoder
  clock**. A pasted URL without it shows **Session clock**.
- **DASH.** The MPD's clock is synthesised so its newest segment ends
  about now, whatever the real delay, and `pdts` doesn't change it. So
  dash.js and Shaka read roughly 30 s low. When it signs DASH, the server
  also fetches the same channel as `pdts=latency` HLS (same `delay`),
  matches a slice in both (the MPD's `$Number$` is the HLS slice number
  within an asset) and returns how far the MPD clock runs ahead. The
  player adds that: **MPD clock + offset**. Pasted MPDs show the raw
  **MPD clock**.

Measured on one channel with the default delay: about 65 s with hls.js
(Uplynk serves 60 s behind and the master's `#EXT-X-START:TIME-OFFSET=0`
starts at the oldest segment) and about 45–50 s with DASH (the newest
segment is about 32 s old, plus the engine's `suggestedPresentationDelay`
of 12.3 s). With `delay=20`: about 28 s and 21 s.

**Encoder wallclock vs program date.** On a slicer with `wallclock: 1`
the ID3 wallclock reads about one slice (≈ 4 s) more latency than the
`pdts=latency` program date for the same picture, on HLS (72.6 vs 68.2 s)
and on DASH (50.4 vs 46.4 s, where the program date comes through the MPD
offset). So the two stamp different moments of a slice, most likely
capture start (wallclock) vs the slice being complete (program date);
ID3, which drives the headline when present, is the closer to
glass-to-glass.

**Delay** in the load bar signs Uplynk's `delay=` (seconds behind live;
Default is the channel's latency profile, 60 s unless set). Synced
channels only; it's kept in the link. The **Clock** table in the Latency
tab shows the clock, the delay, where the master asks players to start
(`EXT-X-START`) and when the session was loaded.

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
🔒 DRM badge on the dashboard); the player selects **FairPlay** for them in
Safari and **Widevine** everywhere else. A channel not yet known to be DRM
is detected on first play (its media playlist carries FairPlay keys) and
replayed with DRM; for a pasted URL the player offers **Play with Widevine
(DASH)** instead.

### FairPlay (Safari)

**DRM → FairPlay** plays HLS in the **Native** engine (Safari's own player)
with EME. The player signs a Preplay v2 session with `rmt=fps` (and
`pdts=latency`, so latency is real), fetches the application certificate
from Preplay's `fairplayCertificateURL`, and opens one key session per
`skd://` key URI. Each license request goes to that URI with `https://`
in front: `POST {"spc": "<base64>"}`, answered with `{"ckc": "<base64>"}`.
Uplynk's FairPlay segments are MPEG-TS, which Safari decrypts only through
its older WebKit EME (`com.apple.fps.1_0`); the player uses that for TS and
standard EME for fMP4. The DRM tab's key system says which.

The tab shows the certificate and license requests (count, time, failures,
also in the waterfall), key status per key id and license expiry.
Robustness doesn't apply to FairPlay. Segment and key timing stay inside
Safari, as with any Native playback. FairPlay needs a synced channel: a
pasted URL has no Preplay response, so no certificate URL. Outside Safari
the option is shown as unavailable.

For AES-128 HLS the tab shows the encryption method, keys seen and key load
time. Uplynk key URIs include the ray (`r=`), so the same key on another
ray isn't counted as a rotation.

## Metadata

On DASH the Uplynk asset (and its ray and slice) comes from the ID3 in
each segment's emsg, ad or content from the MPD: Uplynk's SSAI stitches each ad in as a Period
marked `urn:com:uplynk:ad-asset-id`, and an asset named by any identifier
in such a Period is an ad. The log notes when the MPD gains ad Periods
(`MPD ADS`) and when a new asset isn't one of them (`AD CHECK`).
Other DASH `emsg` boxes are logged with their scheme, size and payload (text if
printable, else the leading bytes in hex).

ID3 frames as they arrive, tallied by kind (TXXX description or PRIV
owner), and how many carried a **wallclock**. Uplynk slicers write the
wallclock only with `wallclock: 1` in their config; without it the ID3
row of the Latency tab says so, and the headline uses the program date
instead. With `CSL_API_TOKEN` set, **Slicer wallclock** shows what
csl-slicer-console's stored config says (on / off and when it was
captured); slicers the console doesn't have (on-prem) show as unknown.
**SCTE-35** in ID3 PRIV frames (and in
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
For DASH the MPD (served on one line) is shown indented, one element per
line.

## Network

Segment count, average load time, bytes and HTTP errors, plus a
**waterfall** of the last 30 seconds of requests: master, media playlists,
init and media segments and key fetches. Slow segments (over half the
target duration) are orange; failures are red.

**Click a request** for its detail: URL (tokens redacted), host, status,
size, total time, **first byte** and **download** (with a split bar),
throughput, a segment's media duration and the share of it the load took,
protocol, and the CMCD it sent. The waterfall stops updating while the
pointer is over it, so rows stay put. First byte comes from hls.js and
dash.js; Shaka and native don't report it and Uplynk's hosts send no
`Timing-Allow-Origin`, so the browser hides it (the panel says which). Cache
hit/miss can't be shown: the CDN's `X-Cache`/`Age` aren't exposed to pages.

**CMCD** (load bar checkbox, `cmcd=1` in links): hls.js, Shaka and dash.js
add a `CMCD=` query param to every request (CTA-5004: object type,
bitrate, buffer length, measured throughput, session and content ids…), so
CDN logs can be joined to this load by its session id. Each load gets a
new session id; the content id is the Uplynk channel id (or the manifest's
file name for a pasted URL). The Network tab shows both ids, how many
requests carried CMCD and the last one decoded, read from the browser's
Resource Timing. Query mode only: Uplynk's content and CDN hosts don't
allow CMCD headers in CORS preflights, so header mode would stop playback.
The native engine has no CMCD.

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
