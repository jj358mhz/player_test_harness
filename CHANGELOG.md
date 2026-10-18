# Changelog

All notable changes to player-test-harness (formerly the standalone Uplynk HLS.js Advanced Latency Monitor) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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