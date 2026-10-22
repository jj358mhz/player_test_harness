# Changelog

All notable changes to player-test-harness (formerly the standalone Uplynk HLS.js Advanced Latency Monitor) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.28.0] - 2026-10-22

### Changed

- **Latency bands renamed, top band moved to 45 s**: GOAT <10 s, Awesome
  10–19 s, Good 19–25 s, Average 25–45 s, Yuk >45 s (were Awesome, Good,
  Average, Above avg 25–40, Yuk >40). Same five colours in the same
  order, on the tiles, the legend, the latency chart, `/compare` and
  recorded sessions.

## [3.27.4] - 2026-10-22

### Fixed

- **Studio DRM channels whose HLS lists AES-128 keys** were taken for
  ordinary AES-128 channels: no 🔒 badge, **▶ Play HLS**, and hls.js
  failed with `keyLoadError (HTTP 400)` once the content (not the ads)
  played. Uplynk's key server refuses their content keys with `400 DRM
  disallows raw key request`. When a check finds AES-128 on content, it
  now asks for that one key: a refusal naming DRM marks the channel DRM,
  so the card reads **▶ Play DRM** and the player uses Widevine DASH.

## [3.27.3] - 2026-10-22

### Fixed

- **DRM channels lost their 🔒 badge during ad breaks.** Ads are AES-128
  even on Studio DRM channels, so a health check (or a Play) during a break
  saw no FairPlay keys and recorded `aes-128`: the card went back to
  **▶ Play HLS** and the player didn't switch to Widevine DASH. A window
  of only ad slices (`#UPLYNK-SEGMENT` kind `ad`) now gives no verdict,
  and once a channel is DRM only `flask check-encryption` can clear it
  (the player and the health check never downgrade it). Channels already
  flipped get the badge back at the first check that sees their content.

## [3.27.2] - 2026-10-21

### Added

- **Preplay request URL**: in Preplay mode the API returns the signed
  request it sent to Uplynk (`preplay_request`), also when Preplay fails.
  The **Advanced…** page shows it under *Preplay request* with **Copy**,
  and the player logs it (`PREPLAY`), so a failing request (e.g. with
  `ad.preroll=1`) can be handed to Uplynk to replay until the token
  expires. Shown only: playback events still keep no signature, and saved
  sessions redact `sig=`.

## [3.27.1] - 2026-10-20

### Fixed
- **No pink text on hovered buttons.** The site-wide link hover colour
  (magenta) won over buttons that are links, so the green ▶ Play buttons
  (and magenta primary ones) showed pink text on hover. Their text now
  stays white, and ghost-button links (e.g. **Advanced…**) keep their
  normal text colour on hover.

## [3.27.0] - 2026-10-20

### Changed
- **Pinned channels stand apart.** On the dashboard, a gold double rule
  with a ★, fading at both ends, separates each account's pinned cards
  from the rest. It looks nothing like the grey section header rule with
  its ▶ chevron, and it hides while the filter leaves no pinned card above
  it or none below. Pins are gold throughout: the ★ and the pinned card's
  border (they were magenta).
- **Green Play buttons.** The filled ▶ buttons (Play HLS/DRM on the
  dashboard, ▶ Play on a channel's health page, ▶ Open in player on Sign
  URL) are green instead of magenta (`.button--play`, `--play`).

## [3.26.1] - 2026-10-20

### Fixed
- **Dashboard much faster with many channels.** With 178 channels it took
  about 1 s to render on the Pi: about half reading the day's ~25,000
  health checks, the rest drawing 178 sparklines and the page. Each worker
  now keeps the sparklines until the next health check run (every
  `CHANNEL_HEALTH_INTERVAL` minutes) or until the channel list changes.
  Locally a repeat view went from 79 ms to 10 ms. The 24-hour window ends
  at the latest check instead of now. Sparklines use whole-pixel
  coordinates, cutting their markup by about a quarter (442 KB to 337 KB
  for 178 cards).

## [3.26.0] - 2026-10-20

### Added
- **Presets can name a channel.** Optional: the Presets page has a
  **Channel** menu (None keeps a preset for any channel), and the player's
  **Save as preset…** has **Include channel** (on when a synced channel is
  selected). Choosing such a preset in the player selects its channel and
  applies the rest; **Open in player** plays it straight away. The list
  shows the channel first (`▶ <channel>`); a channel that has gone inactive
  is marked. Picking another channel clears the Preset menu, like any
  other change.

## [3.25.0] - 2026-10-20

### Added
- **Ad servers come from Uplynk.** Channel sync (the account's **Sync**,
  **Sync all** and the background sync) now also lists the account's ad
  configurations from `/api/v4/ads/servers`. That endpoint is undocumented;
  an Uplynk dev pointed it out. New names are added. Existing rows keep
  their description and extra `ad.*` params and gain the API's type and
  provider. A name Uplynk stops listing is kept and marked **not listed**.
  Names can still be added by hand. If the ad server request fails, the
  channel sync still succeeds and its summary says why.
- The **Ads** menu shows each name with its type. The account page marks
  synced and no-longer-listed rows.

### Changed
- Nothing picks an ad server for a channel: the **Ads** menu still starts at
  **None** unless a link or preset names one. A test now covers this.

### Fixed
- **Faster dashboard.** The 24-hour health history behind the sparklines
  is read as plain columns instead of ORM objects (about half the render
  time with a full day of checks).

## [3.24.0] - 2026-10-20

### Added
- **Params box with a + param menu** (#57). The load bar's second row now
  has **Params** for every synced channel (it was **Ad params**, shown only
  with an ad server). It signs Uplynk customization params into the load,
  including **`expand=`** (parameter expansion sets from the CMS).
  **+ param** lists the documented live-channel params, grouped (General,
  Ads, Studio DRM), each with a line on what it does; picking one adds it
  to the box. Also accepted: any `ad.*`, `fp.*`, `rmp.*` and `pr.*` key.
  `ad.*` needs an ad server or an `expand=` set. Keys the player sets
  itself (`ad`, `rays`, `delay`, `pdts`, CMCD, `ak`, the token) are refused,
  with a pointer to their control. Deep links and presets carry the params
  as themselves; the Presets page's **Ad params** field is now
  **Uplynk params**. The same rules live in `frontend/src/lib/uplynkParams.ts`
  and `app/uplynk/params.py`, and a test checks the two match.

## [3.23.3] - 2026-10-20

### Fixed
- **Readable Preplay errors.** A Preplay failure no longer shows Uplynk's
  raw HTML (`<html><body>Server error, sorry</body></html>`), just the
  text. When Preplay fails with a server error (5xx) and `ad.*` params
  were signed, the message names them and explains: Uplynk's Preplay
  returns HTTP 500 with `ad.preroll=1` (undocumented), while a signed
  manifest URL with the same params plays the preroll. Without DRM a
  signed URL skips Preplay; DRM channels need it, so they can't use it.

## [3.23.2] - 2026-10-20

### Changed
- **Shorter channel cards.** **Play**, **Copy HLS**, **Copy DASH** and
  **Advanced…** sit in a 2×2 block on the right of each card, beside the
  IDs and the health sparkline, instead of a row of their own underneath.
  A card too narrow for both puts them back underneath.

## [3.23.1] - 2026-10-20

### Fixed
- The count beside the Presets and Recorded sessions headings now says
  what it counts ("3 saved"), like the dashboard's "12 active", instead of
  a bare number that read like a footnote.

## [3.23.0] - 2026-10-20

### Added
- **Presets page** (site menu → **Presets**, `/presets`). Every saved
  preset in one table, its settings in plain words (`DASH · Shaka 5.3.0 ·
  Widevine · delay 30 s · ad=fw2 ad.lib=KOR · CMCD`), with **Open in
  player**, **Edit** and **Delete**. A form adds a preset from fields
  (format, engine and version, DRM, delay, ad server, ad params, CMCD) or
  edits one, including renaming it; the same checks as the player's.
  **Open in player** lands on `/player?preset=<id>` with it applied.

### Changed
- **Tidier load bar.** **Preset** comes first, ahead of the channel, since
  it sets everything to its right. **Presets…** and its save/delete row are
  now **Save as preset…**: a name, Save, and a **Manage presets** link
  (deleting moved to the Presets page). The boxes a choice asks for, the
  custom **Engine version** and **Ad params**, moved from under their
  menus to the left of the second row, so the first row keeps one height.

## [3.22.2] - 2026-10-19

### Changed
- **Ad params read plainly in links and presets.** The player link carries
  them as themselves, exactly as they're signed into the Uplynk URL:
  `…&ad=fw2&ad.lib=KOR&ad.kv=genre:news`, instead of v3.22.0's packed
  `adp=ad.lib%3DKOR`. Links and presets in the old form still load (and
  presets list in the new one). After a preset is applied the box shows
  the params as typed, not URL-encoded.

## [3.22.1] - 2026-10-19

### Changed
- **"← Back to channels" on every page.** It's now part of the site
  layout rather than a few pages' own markup: Player, Compare, Sign URL,
  Sessions, a recorded session, Activity, the Uplynk Accounts pages and a
  channel's health page all have it. Pages about one channel (the player
  opened on a channel, Sign URL for a channel, a session, a health page)
  land on that channel's card. Not shown on the dashboard itself, the
  sign-in page or compare's embedded panes.

## [3.22.0] - 2026-10-19

### Added
- **Per-load ad params.** With an ad server chosen in **Ads**, a box under
  it takes this playback's own `ad.*` params, e.g. `ad.lib=KOR` or
  `ad.lib=JPN&ad.kv=…`, for values that change per customer or test and
  don't belong in the account's list. Only `ad.*` keys with plain values
  (letters, digits, `_ . , : / | -` and spaces), at most 10; they're signed
  on top of the account's defaults and win on a clash. Deep links and
  presets carry them as `adp=` (checked again on the server), so "fw2 KOR"
  and "fw2 JPN" can be saved presets.

## [3.21.0] - 2026-10-19

### Added
- **Ad servers per account, and an Ads menu in the player.** Uplynk inserts
  ads (SSAI) only when the playback URL names an ad configuration
  (`ad=<name>`), and it has no API that lists them. An admin now adds each
  account's names, with an optional description and default `ad.*` params
  (e.g. `ad.breakend=chop`), under **Uplynk Accounts → Edit → Ad servers**
  (`ad_servers` table, new migration). The load bar's **Ads** menu offers the
  selected channel's account's names (None by default; disabled for pasted
  URLs) and signs `ad=<name>` plus its params. Deep links and saved presets
  carry it as `ad=`; a preset applies it only where the channel's account
  has that name.

## [3.20.1] - 2026-10-19

### Fixed
- **DASH ad detection for Uplynk SSAI.** An asset now counts as an ad when
  any `AssetIdentifier` in an ad Period (one carrying
  `urn:com:uplynk:ad-asset-id`) names it, not only that identifier's own
  value, which may be an ad-server id rather than the asset in the ID3.
  This is the layout Uplynk documents ("ad Periods identifiable via
  AssetIdentifier urn:com:uplynk:ad-asset-id"); not yet seen on a real
  ad break. CLAUDE.md records the SSAI signalling (incl. the opt-in
  `ad.timedmeta=1` break markers).

### Added
- Log lines to confirm it on the next ad: **MPD ADS** when the MPD gains
  ad Periods (their ids and identifiers), and **AD CHECK** when a new
  asset plays that none of them name.

## [3.20.0] - 2026-10-19

### Added
- **Channel health for the slicer console.** `GET /api/health/slicers`
  returns the latest health check of every active channel that has a
  slicer (status, edge age, detail, when, and a link to its health page).
  It takes `Authorization: Bearer <CSL_API_TOKEN>` (the secret the player
  already shares with csl-slicer-console) instead of a login, and is off
  (404) without it. csl-slicer-console v1.18.0 shows it as a badge on each
  slicer card.

## [3.19.0] - 2026-10-19

### Added
- **Health history.** Every health check is kept (`channel_health_checks`,
  new migration) for `HEALTH_HISTORY_DAYS` (default 7; each run prunes
  older ones).
- **Sparklines on the dashboard.** Each checked channel's card shows its
  live-edge age over the last 24 hours (amber and red dots for behind,
  stale and failed checks, dashed lines at the 90 s and 5 min thresholds,
  gaps where nothing was checked), and a channel that needs attention says
  since when, in your local time.
- **Channel health page** (`/channels/<id>/health`, from the sparkline):
  the last 24 hours and the whole kept history as larger charts, and every
  status change with the edge age then and how long it lasted.

### Changed
- Durations of two days or more read as days and hours (`4 d 18 h`).

## [3.18.0] - 2026-10-19

### Added
- **Channel health on the dashboard.** The server fetches each active
  channel's HLS signed with `pdts=latency` (master and first media
  playlist) and measures how old the newest segment is on the encoder's
  clock. Each card gets a badge: green with the age at the live edge
  (about 30 s with the default delay), amber when more than 90 s behind,
  red when stale (over 5 minutes, or the playlist has ended) or when
  Uplynk answers with an error (its text on hover), grey when the playlist
  has no program dates. The header says how many need attention (a link
  that filters to them; `attention`, `stale`, `error` also work in the
  filter box) or "all at the live edge".
- Runs every `CHANNEL_HEALTH_INTERVAL` minutes (default 10, 0 = off) in
  the auto-sync thread, **Check health** on the dashboard runs it now, and
  `flask check-health [--account …]` from the CLI. Each check also records
  the channel's encryption (the 🔒 DRM badge). New columns on `channels`
  (migration).

### Changed
- Issue #24 (Phase 4) closed; LL-HLS moved to #48 (on hold).

## [3.17.1] - 2026-10-19

### Changed
- **Load bar layout.** Load sits level with the fields; Copy link, Save
  session and Presets… move to a slim row under them (right-aligned), so
  the bar is one row of fields instead of four stacked buttons tall. At
  tablet width Load and those buttons share the last row and CMCD lines up
  under its label; on a phone they stack under Load.
- **Site header on narrow screens** wraps the nav under the brand and hides
  the signed-in email (Sign out stays), so no page scrolls sideways at
  phone width. It used to push every page to about 740 px wide.

## [3.17.0] - 2026-10-19

### Added
- **Saved engine presets.** A named setup of format, engine and version,
  DRM, delay and CMCD, kept on the server (`engine_presets` table, new
  migration) so every browser sees the same list. The load bar has a
  **Preset** menu that applies one to the selected channel (then press
  Load), and **Presets…** opens a row to save the current settings under a
  name (the same name replaces it) or delete the chosen one. An engine's
  default version isn't pinned, so presets follow Dependabot's bumps; pick
  an exact version to pin. Changing a setting by hand clears the menu.
  The list refreshes when the menu is focused or the row opens.
- `/api/presets`: GET, POST `{name, query}`, DELETE `/api/presets/<id>`.
  The query is the player's deep-link query without the source or rays,
  re-checked on the server with the same rules as deep links (engine
  versions end up in a jsDelivr URL).

## [3.16.2] - 2026-10-19

### Documentation
- Why the encoder wallclock reads about one slice (≈ 4 s) more than the
  `pdts=latency` program date: measured on HLS (Safari, FairPlay) and
  DASH on the same `wallclock: 1` channel, so it's how Uplynk stamps the
  two, not DASH anchoring. `docs/player.md` "Which clock" and CLAUDE.md.

## [3.16.1] - 2026-10-19

### Added
- **DASH asset from ID3.** Uplynk's DASH ID3 names the slice in a TXXX
  with no description: `<asset id>_<ray>_<slice>`. When that slice
  reaches the playhead the Metadata tab's **Asset** row shows the asset,
  slice and ray (it said "--" on DASH), and an asset change is logged
  like HLS's `#UPLYNK-SEGMENT`. Ad or content comes from the MPD's
  `AssetIdentifier urn:com:uplynk:ad-asset-id`, so ad assets open an ad
  break on the timeline.

### Changed
- The Encoder wallclock row's description names ID3 in DASH emsg.

## [3.16.0] - 2026-10-19

### Added
- **ID3 from DASH emsg.** v3.15.0's payload preview showed that Uplynk's
  `com.uplynk.asset.metadata` emsg is an ID3v2.4 tag, the same ID3 HLS
  carries (and its segments have no `prft`). Shaka and dash.js now pass
  it to the ID3 handling at the emsg's presentation time, so on DASH the
  Metadata tab counts ID3 samples and frames, the log shows the TXXX
  values, and on slicers with `wallclock: 1` the **Encoder wallclock**
  row gives real DASH encoder latency (and drives the headline) instead
  of the MPD clock + offset. dash.js subscribes to that scheme (and AOM's
  `https://aomedia.org/emsg/ID3`). The Latency tab's DASH status now
  reads "no prft or ID3 emsg in N DASH segments" only when neither shows up.

## [3.15.0] - 2026-10-19

### Added
- **DASH encoder latency from `prft`.** Shaka and dash.js now read each
  DASH video segment's `prft` (ProducerReferenceTime) box and anchor its
  wall-clock time at the segment's presentation start (corrected by
  `tfdt` and the init segment's timescale). That feeds the same
  at-the-playhead clock as HLS ID3, so DASH gets a real encoder latency
  instead of the MPD clock + offset, and it drives the headline when
  present. The Latency tab's first row is now **Encoder wallclock**
  (ID3 on HLS, prft on DASH); the Metadata tab has a **prft** row
  (count and type, or "none in N segments"), and the log notes the
  first one. Whether Uplynk's packager writes `prft` isn't documented:
  this release is how we find out.
- **emsg payloads** in the log: text when printable, else leading hex
  (e.g. the 66-byte `com.uplynk.asset.metadata`), to learn what they carry.

## [3.14.1] - 2026-10-19

### Fixed
- **Slicer wallclock** said "not in the slicer console (on-prem?)" for
  any 404, including when the console's settings API is off
  (`PLAYER_API_TOKEN` unset there, or a console older than v1.17.0). It
  now tells them apart: an unknown slicer (the API's JSON error) is
  still "not in the slicer console", while a plain 404 page reads
  "slicer console API is off". Errors aren't cached, so fixing the
  console's setting shows up on the next load.

## [3.14.0] - 2026-10-19

### Added
- **Slicer wallclock from csl-slicer-console.** For channels whose slicer
  is in the console, the player asks it (server to server, through the
  new `GET /api/channels/<id>/slicer`) whether the slicer's config has
  `wallclock: 1`. The Metadata tab shows **Slicer wallclock** (on / off,
  with the config's capture time, or why it's unknown: not in the
  console, i.e. on-prem, or no config captured yet), and the Latency
  tab's ID3 row says "the slicer has it off" instead of guessing. Needs
  console v1.17.0 and `CSL_API_TOKEN` (the console's `PLAYER_API_TOKEN`);
  `CSL_API_URL` is where this container reaches the console (default
  `CSL_BASE_URL`). Answers are cached 5 minutes; the token never reaches
  the browser.

## [3.13.3] - 2026-10-19

### Changed
- **Why there's no ID3 latency.** The Metadata tab tallies ID3 frames by
  kind (TXXX description, PRIV owner) and counts wallclock timestamps. The
  Latency tab's ID3 row now separates "no ID3 in the stream yet" from "ID3
  has no wallclock (slicer `wallclock: 1` off?)". It used to say "no ID3
  timestamps yet" either way, which looked like a player fault on channels
  whose slicer doesn't write the wallclock.

## [3.13.2] - 2026-10-19

### Fixed
- The Clock table said **Session clock** for HLS played through Preplay
  (FairPlay), whose session URL doesn't repeat the signed `pdts=latency`.
  The latency was already on the encoder clock; only the label was wrong.

## [3.13.1] - 2026-10-19

### Fixed
- **FairPlay in Safari** stopped at "waiting for license" with
  `MEDIA_ERR_DECODE`: Safari never asked for a key. Uplynk's FairPlay
  segments are MPEG-TS, and Safari's standard EME only handles FairPlay for
  fMP4. TS now uses Safari's older WebKit EME (`WebKitMediaKeys`,
  `com.apple.fps.1_0`, `webkitneedkey`), as in Apple's FPS sample and
  Shaka; standard EME is kept for fMP4. The DRM tab names which one is in
  use, and a decode error with no key request now says so.

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