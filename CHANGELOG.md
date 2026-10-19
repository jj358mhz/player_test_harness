# Changelog

All notable changes to player-test-harness (formerly the standalone Uplynk HLS.js Advanced Latency Monitor) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.13.0] - 2026-10-19

### Added
- **FairPlay in Safari** (#21): **DRM → FairPlay** plays Studio DRM HLS
  in the Native engine with EME. Preplay v2 with `rmt=fps` gives the
  application certificate (`fairplayCertificateURL`); each `skd://` key URI
  gets its own key session, and its license request goes to the same URI
  over https (`{"spc": …}` → `{"ckc": …}`). The DRM tab shows certificate
  and license timing and failures, key status per key and license expiry;
  both requests appear in the waterfall. In Safari, DRM channels pick
  FairPlay automatically (Widevine elsewhere, as before), and links can
  carry `drm=fps`.

### Changed
- Outside Safari the FairPlay option reads "Safari only" (it said
  "coming"); a `drm=fps` link opened there falls back to the channel's
  default. Leaving the Native engine turns FairPlay off.

## [3.12.0] - 2026-10-18

### Added
- **Automatic channel sync** every `CHANNEL_SYNC_INTERVAL` minutes
  (default 60; 0 = off). An account syncs when its last successful sync,
  manual or automatic, is older than that; a failed one is retried after 5
  minutes. Activity gets an entry only when channels were added or removed,
  or the sync failed. One gunicorn worker runs it (file lock); if it
  restarts, another takes over. The Uplynk Accounts page shows the
  interval.

### Fixed
- `docker-compose.yml` passes only the variables it lists, so
  `SESSION_RETENTION_DAYS`, `MAX_RECORDING_BYTES` and `CSL_BASE_URL` set in
  `.env` never reached the app. They're passed now, with
  `CHANNEL_SYNC_INTERVAL`.

## [3.11.1] - 2026-10-18

### Fixed
- **The Channels filter didn't hide anything.** It marked non-matching
  cards `hidden` and updated the section counts, but `.channel-card` sets
  `display: flex`, which beats the browser's own `[hidden]` rule, so every
  card stayed on screen. A global `[hidden] { display: none !important }`
  makes the attribute win everywhere (also for `?q=` links from the
  slicer console and the DRM filter).

## [3.11.0] - 2026-10-18

### Added
- **Request detail in the waterfall.** Click a request in the Network tab
  for its URL (tokens redacted), host, status, size, total time, **first
  byte vs download** (a split bar), throughput, the segment's media
  duration and how much of it the load took, protocol and the CMCD it
  sent. The waterfall holds still while the pointer is over it.
  - First byte comes from hls.js and dash.js. Shaka and native don't
    report it, and Uplynk's hosts send no `Timing-Allow-Origin`, so the
    browser hides it too; the panel says so. If a host ever allows it,
    Resource Timing fills it in for every engine.
  - Cache hit/miss isn't shown: the CDN sends `X-Cache`/`Age` but doesn't
    expose them to pages; the panel says so.
- Slow segments are judged against their own duration where the engine
  reports it (was the target duration).
- Recordings keep first byte, media duration and host/path per request;
  the replay's request table has a First byte column.

### Changed
- The **LIVE** chip is green; its dot still blinks red.

## [3.10.0] - 2026-10-18

### Added
- **CMCD toggle** in the load bar (and `cmcd=1` in deep links): hls.js,
  Shaka and dash.js send CMCD (CTA-5004) as a `CMCD=` query param on every
  request, with a fresh session id per load and the Uplynk channel id as
  content id, so CDN logs can be matched to a session. The Network tab
  shows the ids, how many requests carried CMCD and the last one decoded
  (object, bitrate, buffer, throughput…); a **CMCD** chip shows it's on;
  recordings keep the session id. Query mode only: Uplynk's hosts don't
  allow CMCD headers in CORS preflights. Not in the native engine.
- **Links to csl-slicer-console.** With `CSL_BASE_URL` set, a channel's
  slicer on the dashboard and a chip in the player link to the slicer's
  card (`/slicers/by-id/<slicer>`, console v1.16.0).
  `/channels/by-slicer/<slicer>` is the way back: one channel opens the
  player, several open the dashboard filtered to them.
- The dashboard filter takes `?q=`.

## [3.9.0] - 2026-10-18

### Added
- **Compare** (`/compare`, in the nav): two players side by side, each
  with its own format, engine and version, DRM and delay. Pick a channel
  and a preset (HLS vs DASH, hls.js vs Shaka, Shaka vs dash.js, default vs
  20 s delay) and **Load both**, or change either pane's load bar. A table
  lines up latency (now, avg, min/max), clock, drift, buffer, ray,
  bandwidth estimate, startup, rebuffers, errors, ray switches and segment
  time, with **B − A**; one chart draws both latencies. **Copy link**
  (`/compare?a=<player query>&b=<player query>`) and **Save both** (two
  recorded sessions; both links copied).
- **Startup** (engine load to first frame) in the log, recordings and
  compare.

### Changed
- Each compare pane is the full player in an iframe (`/player?embed=1`:
  no site header, compatibility panel or Copy link), so two engines and
  versions never share a page (Shaka's build is a global).

## [3.8.0] - 2026-10-18

### Added
- **Real latency for DASH.** Uplynk's MPD clock puts the newest segment at
  about now, so dash.js and Shaka read about 30 s low. When it signs a
  live DASH URL, the server also fetches the channel as `pdts=latency`
  HLS, matches a slice in both and returns the MPD clock's offset
  (`clock` in `POST /api/playback`); the player adds it (**MPD clock +
  offset**).
- **Delay** in the load bar: signs Uplynk's `delay=` (15–120 s, or the
  channel default) for synced channels, and `delay=` in deep links.
- **Clock** table in the Latency tab: which clock the program dates use,
  the delay, the master's `EXT-X-START` and when the session was loaded.
  Recordings keep the clock and delay.

### Changed
- The player signs synced HLS with **`pdts=latency`**, so program dates
  are encoder time. Uplynk's default dates start at the session's first
  slice: they read about 5 s low and drift when a session idles (the
  "old Preplay sessions fall behind" item in #24). Pasted URLs without it
  are labelled **Session clock**. The Sign URL page and the dashboard's
  Copy buttons are unchanged.

## [3.7.0] - 2026-10-18

### Added
- **Recorded sessions.** **Save session** in the player keeps what the
  current load measured and copies a link to `/sessions/<id>`: summary
  tiles, latency and drift over the whole session with events and ad
  breaks, latency stats per source, the ray ladder, request totals by kind
  (count, failed, avg, p95), the last 400 requests, DRM and key status,
  the log and the browser. **Open live** reopens a synced channel with a
  fresh signature; **Download JSON**; **Delete**. A **Sessions** page lists
  them.
- `SESSION_RETENTION_DAYS` (default 30; 0 keeps them) and
  `flask prune-sessions [--days N]`; every save also prunes.
  `MAX_RECORDING_BYTES` caps an upload (default 8 MiB).
- The player keeps the whole session's latency, drift, events and log for
  recordings (the live views still show five minutes).

### Security
- Recordings are redacted in the browser and again on the server: `sig=`
  and `pbs=` (also percent-encoded), the session part of Preplay play
  URLs, and license URL queries. Pasted URLs are stored without a live
  link.

## [3.6.0] - 2026-10-18

### Added
- **Deep links.** The player's address bar now describes the whole view:
  source (`channel=` or `src=`), `format=dash`,
  `engine=<hlsjs|shaka|dashjs|native>@<version>`, `drm=wv|pr`, `rays=`,
  and the tab in the hash. Opening the link sets the load bar and plays.
  A **Copy link** button next to Load copies it. DRM chosen automatically
  for a DRM channel isn't written, so the channel decides again on open.

### Security
- Engine versions from a link or the custom-version box must be exact
  releases (`1.6.15`, `5.0.0-beta.2`); anything else falls back to the
  default, so a link can't point the jsDelivr import elsewhere.

## [3.5.0] - 2026-10-18

### Added
- **dash.js engine** (5.x, loaded from jsDelivr; the menu offers the latest
  patch of the last three minor lines plus a custom version). Plays DASH,
  Widevine and PlayReady with the same panels as Shaka: ray-labelled
  ladder and switches, PDT latency, drift against its target delay,
  request waterfall, license timing, key status, robustness and expiry.
  Picking dash.js with a DRM uses it instead of Shaka.
- **Native engine** (listed when the browser says it plays HLS): hands
  the URL to `<video>`, as Safari does. Ladder and rays come from the
  harness's own copy of the master; the current ray from the frame size;
  latency from ID3 metadata cues and `getStartDate()`; requests from
  Resource Timing where the browser reports them. The log and waterfall
  say what the browser keeps hidden.
- Compatibility panel names the new engines and explains that Uplynk DASH
  is CENC even without Studio DRM.

### Fixed
- License log lines no longer claim `0 bytes` when the engine doesn't
  report a size.

### Notes
- Uplynk lets a browser use a signed DASH URL once (`403 DRM sig reuse
  rejected` on reuse). Synced channels are re-signed on every Load; a
  pasted DASH URL has to be signed again before loading it in another
  engine.

## [3.4.0] - 2026-10-18

### Added
- **DRM badge** on dashboard channel cards (🔒 DRM, and **▶ Play DRM**) and
  🔒 in the player's channel picker, so Studio DRM channels are obvious
  before you press Play. Filtering for `drm` finds them.
- The harness learns each channel's encryption whenever it signs HLS: the
  manifest probe follows the first variant and classifies its `EXT-X-KEY`
  (FairPlay keys → Studio DRM, `AES-128`, `SAMPLE-AES`, none). A Preplay
  answer with `drm.required` counts too. Stored on the channel
  (`encryption`, `encryption_checked_at`; migration `9bcf3205d3d3`).
- **Check HLS & DASH** shows a 🔒 DRM pill and updates the badge in place.
- `flask check-encryption [--account LABEL]` probes every active channel's
  HLS once (4 at a time) to fill in the badges without playing anything.

### Changed
- In Chrome/Edge/Firefox the player picks **DRM → Widevine** (DASH, Shaka)
  for a DRM channel, and goes back to HLS/hls.js for a clear one unless you
  chose the DRM setting yourself. A channel found to be DRM on first play
  is replayed as Widevine automatically instead of stopping at the
  FairPlay error. Safari is left alone (FairPlay is #21).

## [3.3.1] - 2026-10-18

### Documentation
- New **[wiki](https://github.com/jj358mhz/player_test_harness/wiki)**:
  getting started, accounts and sync, dashboard, signing and Preplay, the
  player, latency and drift, DRM, browser compatibility, Uplynk
  conventions, troubleshooting, deployment and development. Linked from
  the README; CLAUDE.md says to keep it current with each release.

## [3.3.0] - 2026-10-18

### Added
- **Compatibility panel** on the player page (collapsible, under the load
  bar): a live check of this browser (HTTPS, Media Source Extensions,
  native HLS, Widevine with L1/L3, PlayReady, FairPlay, ClearKey), a
  browser × format × DRM matrix with this browser highlighted, and how
  Uplynk maps onto it (Studio DRM over HLS is FairPlay; over DASH via
  Preplay `rmt=wv|pr` it is Widevine/PlayReady; `Non dash asset`; which
  engine the harness uses). The FairPlay warning links to it ("Why?").

## [3.2.2] - 2026-10-17

### Changed
- **Timeline** plots latency and **live-edge drift** together on one
  seconds scale (drift dashed), with labelled grid lines, minute ticks,
  current values at the right edge, and events in their own lane. Rising
  latency with rising drift means the player is falling behind the edge;
  rising latency with steady drift means the stream itself is late.
- **Drift tile** colours itself without an engine target (Shaka): green up
  to 15 s, amber to 45 s, red beyond.

## [3.2.1] - 2026-10-17

### Fixed
- **DASH ray ladder** shows Uplynk-style profiles (`high-31`, `main-13`)
  from the codec instead of a truncated codec string; HLS falls back to the
  same when `#UPLYNK-MEDIA0` is missing.
- **Last segment / waterfall** under DASH: audio segments are labelled
  `audio` instead of `ray ?`, and video segments carry their ray (from the
  Representation id; Uplynk DASH segments end in `.m4f`).
- **Manifest tab under DASH** shows the MPD's facts — container, max segment
  duration, time-shift window, update period, periods (ad periods counted),
  availability start — and the latest MPD text with signatures hidden,
  instead of empty HLS fields and "Waiting for a media playlist".

## [3.2.0] - 2026-10-17

### Added
- **DRM playback in Chrome: Widevine (and PlayReady) over DASH** with a new
  **Shaka Player** engine. Pick DRM → Widevine; the player signs a Preplay
  v2 session (`rmt=wv`) and hands Shaka the session's license URL.
- **DRM & keys tab:** key system, license server, license requests (count,
  time, failures), robustness, license expiry, and **key status per key**
  with hints for `output-restricted` (HDCP) and other failures. DRM errors
  carry plain-language explanations (e.g. 6007 license request failed).
- **Shaka Player versions** in the engine menu, from npm like hls.js
  (latest patch of the last three minors) plus a custom version.
- **DASH** format: rays from Representation ids (A–H), request waterfall,
  license requests on the timeline.
- FairPlay channels in Chrome now say what's wrong — Studio DRM over HLS is
  FairPlay, which only Safari can play — with a **Play with Widevine (DASH)**
  button, instead of a bare key error.
- A pasted `.mpd` URL switches to DASH automatically.

### Fixed
- Loading a new stream now waits for the previous player to let go of the
  video element (Shaka could otherwise never attach).
- The latency chart no longer freezes on VOD content, and wall-clock latency
  is only measured on live streams.

## [3.1.1] - 2026-10-17

### Fixed
- **Channel sync reads every page.** Uplynk's channels API returns at most
  40 channels per page, so workspaces with more than 40 only synced the
  first 40. Sync now walks `page=1, 2, …` until it has `total_items`, and
  fails (without deactivating anything) if the count comes up short.

## [3.1.0] - 2026-10-17

### Added
- **Dashboard navigation** carried over from CSL: account chips that jump to
  a section and highlight the one in view, collapsible account sections, and
  **Collapse all / Expand all** (remembered per browser).
- **Select all** per account and a checkbox on each channel, with a batch
  bar: **Check HLS & DASH** (signs both and marks each card ✓/✗ with
  Uplynk's reason), **Copy HLS URLs / Copy DASH URLs** (signed, one per
  channel), and **Pin / Unpin**.

## [3.0.1] - 2026-10-17

### Fixed
- The Sign URL page opened from a channel's **Advanced…** button has a
  **← Back to channels** link that returns to that channel's card.

## [3.0.0] - 2026-10-17

The standalone player becomes a self-hosted service: Uplynk accounts, channel
sync, server-side URL signing and a rewritten player.

### Added
- **Backend service** (Flask, SQLAlchemy, Alembic) modelled on
  csl-slicer-console: login, CSRF, argon2 passwords, Fernet-encrypted
  credentials at rest.
- **Uplynk accounts:** API key (signs playback tokens) plus an optional
  Scoped API Key `.env`.
- **Channel sync** from `GET /api/v4/channels` with the scoped key (JWT) or
  classic auth: per-account Sync, Sync all, and `flask sync-channels`.
- **Signed playback API** (`POST /api/playback`): channel GUID or external
  ID, HLS or DASH, token lifetime and signed extra params. **Preplay v2**
  returns the Widevine / PlayReady / FairPlay license URLs.
- **Manifest check after signing:** the server fetches the signed manifest
  once and shows Uplynk's answer (e.g. `HTTP 400: Non dash asset <id>`).
- **Channels dashboard** (filter, favorites, play, copy HLS/DASH), **Sign URL**
  page and **Activity** log. Signatures are never stored.
- **New player** at `/player`, in TypeScript + Vite: load bar (synced channel
  or pasted URL, engine version), video with six vitals, a five-minute event
  timeline, and tabs for Latency, ABR, DRM & keys, Metadata, Tracks,
  Manifest, Network and Log.
- **Latency at the playhead:** ID3 wallclock and PDT account for the buffer.
  Current / Average / Max / Min tiles keep the Awesome … Yuk bands.
- **Uplynk rays** label every rendition, with fps and profile from
  `#UPLYNK-MEDIA0`; toggling rays re-signs the channel with `rays=`.
- **SCTE-35 decoding** (splice_insert, time_signal, segmentation
  descriptors) from ID3 PRIV and `#EXT-X-DATERANGE`, applied at the
  playhead, with ad breaks shaded on the timeline. `#UPLYNK-SEGMENT` shows
  the asset playing and its kind.
- **Tracks:** audio and caption/subtitle switching (incl. CEA-608) with live
  cue text, and an audio level meter that logs silence.
- **Network** request waterfall; **Manifest** tab with the master and the
  current media playlist (signatures hidden).
- **hls.js version menu** from npm: latest patch of the last three minor
  lines plus any custom version, loaded from jsDelivr.
- Docker image, Compose stack and SSH deploy to the Utility Pi; CI for
  Python, the frontend and the Docker build; Dependabot.
- App icon and web manifest.

### Changed
- The single-file HLS.js Advanced Latency Monitor is replaced by the new
  player and removed. Its latency figures were taken at download time and
  read higher by roughly the buffer length.
- ▶ Play on the dashboard opens `/player?channel=<id>`; the player signs and
  checks the URL itself.

### Fixed
- Gunicorn workers no longer crash racing to create the bootstrap admin, and
  gunicorn 26's unused control socket is disabled.
- Back-to-back merges no longer run overlapping deploys.
- Channel cards keep IDs on one line; select arrows have room on the right.

## [2.1.0] - 2026-05-22

### Changed
- **HLS.js** - Default to 1.6.16; version selector now offers 1.6.14-1.6.16
- **Presets** - Removed workspace-specific Uplynk channel presets; public test streams remain
- **Repository** - Moved to GitHub; docs updated to point to GitHub issues and pull requests

## [2.0.0] - 2024-12-16

### Added
- **HLS.js Version Selector** - Switch between HLS.js versions (1.6.13-1.6.15) with hot reload
- **Enhanced DRM Monitoring** - Complete key tracking system with:
  - Unique key identification with color coding
  - Key rotation detection and notifications
  - Detailed key history log with hover tooltips
  - Key legend showing all unique keys
  - Support for custom license server URLs
- **CMAF/Format Detection** - Automatic detection of:
  - Container format (fMP4, MPEG-TS, CMAF)
  - Init segments and byte-range mode
  - Codec information
  - Media segment counts
- **Tab Visibility Monitoring** - Warns when stream drifts while tab is hidden
  - Configurable auto-jump on return
  - Visual notifications
  - Drift tracking during hidden state
- **Master Manifest Viewer** - Enhanced manifest inspection:
  - Color-coded variant streams
  - Hover tooltips with full details
  - Raw manifest view with syntax highlighting
  - Audio and subtitle group detection
- **Discontinuity Tracking** - Comprehensive discontinuity monitoring:
  - Real-time detection
  - Historical log with context
  - Line numbers and segment info
- **Debug Mode Toggle** - Enable/disable verbose logging from UI
- **Performance Optimizations**:
  - DOM element caching
  - Batch updates for multiple DOM changes
  - Throttled graph rendering (30-60fps)
  - Reduced getElementById calls

### Changed
- **Improved UI Layout** - Better organization of monitoring sections
- **Enhanced Graphs** - More responsive and smooth animations
- **Better Error Handling** - More informative error messages
- **Updated Latency Classifications**:
  - Awesome: <10s (dark green)
  - Good: 10-19s (green)
  - Average: 19-25s (light orange)
  - Above Average: 25-40s (orange)
  - Yuk: 40s+ (red, pulsing)

### Fixed
- Audio bitrate measurement now more accurate
- Key rotation counting works correctly
- Tab visibility warnings trigger reliably
- Graph rendering performance improved
- Memory leaks in long-running sessions

## [1.5.0] - 2024-11-15

### Added
- **Audio Track Monitor** with Web Audio API
  - Real-time audio level visualization
  - Multi-track support
  - Codec and bitrate detection
- **Caption/Subtitle Monitor**
  - Live caption display
  - Caption history log
  - Track selection
  - Format detection (WebVTT, CEA-608/708)
- **Program Date Time** tracking and comparison
- **ABR Bandwidth Monitor**
  - Bandwidth estimate graphing
  - Quality switch logging
  - Throughput tracking

### Changed
- Reorganized dashboard layout
- Improved mobile responsiveness
- Enhanced graph legends

### Fixed
- Caption cuechange events now fire correctly
- Audio track switching more reliable
- PDT parsing handles more formats

## [1.0.0] - 2024-10-01

### Added
- Initial release
- **ID3 Metadata Parser**
  - PRIV, TXXX, and text frame support
  - SCTE-35 detection
  - Hex dumps
- **Latency Monitoring**
  - Wall-clock timestamp parsing
  - Real-time latency calculation
  - Historical statistics
  - Latency graph
- **Live Edge Drift Monitor**
  - Visual gauge
  - Auto-sync capability
  - Drift history graph
- **Performance Metrics**
  - Buffer levels
  - Download speeds
  - Quality levels
  - Dropped frames
  - Rebuffer tracking
- **DRM/Encryption Monitor**
  - AES-128 detection
  - Key URI tracking
  - Basic DRM support
- **HTTP Status Monitor**
  - Request categorization
  - Success rate calculation
  - Request log
- **Manifest Viewer**
  - Media playlist display
  - Segment information
- **Preset Streams**
  - Uplynk test streams
  - Public test streams
  - Encrypted test streams

### Features
- Jump to Live button
- Quality level selector
- Collapsible dashboard sections
- Dark theme UI
- No build process required
- Single HTML file

---

## Version History Legend

- 🎉 **Added** - New features
- 🔄 **Changed** - Changes to existing functionality
- 🐛 **Fixed** - Bug fixes
- 🗑️ **Removed** - Removed features
- 🔒 **Security** - Security improvements

## Upgrade Notes

### From 1.x to 2.0

**Breaking Changes:**
- None - fully backward compatible

**New Requirements:**
- None - same browser requirements

**Migration Steps:**
1. Replace old HTML file with new version
2. Clear browser cache to load new HLS.js versions
3. Re-select your preferred HLS.js version if different from default

**New Features to Try:**
1. Open DRM Monitor and click debug mode
2. Try the new HLS.js version selector
3. Load a stream and watch tab visibility warnings
4. Check out the new master manifest viewer
5. Review the enhanced key tracking in DRM monitor

---

## Future Releases

See the [issue tracker](https://github.com/jj358mhz/player_test_harness/issues) for planned features and improvements.