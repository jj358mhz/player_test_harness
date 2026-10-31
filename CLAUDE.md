# CLAUDE.md

Working notes for Claude (and humans) on this repo. Keep this file current:
update the roadmap/status and any convention that changes in the same PR.

## What this is

Engineering harness for triaging Uplynk playback and measuring low-latency
behaviour. A Flask service syncs live channels from Uplynk workspaces, signs
playback URLs server-side, and serves a monitoring player. Single user (the
repo owner), reached over LAN/VPN only. Sister project and template:
`~/github/csl-slicer-console` — copy its patterns before inventing new ones.

## Hard rules

- **The repo is public.** Never commit workspace-specific data: API keys,
  channel/asset/event GUIDs, external IDs, customer or channel names, work
  email addresses, internal hostnames. All of that lives in the database.
  Test fixtures use obviously fake values (`chan0001`, `owner123`).
- **Uplynk API keys never reach the browser.** Signing happens server-side
  in `app/uplynk/playback.py`. Don't add endpoints that return keys.
- **Never store signatures.** `playback_events` keeps the base URL and
  params only.
- **Every PR bumps the version and the CHANGELOG** (same as CSL): patch for
  fixes, minor for features, major for breaking changes. Version lives in
  `pyproject.toml` (and `uv.lock`); add a `## [x.y.z] - YYYY-MM-DD` section.
  After merging, tag the merge commit `vX.Y.Z` (annotated, message
  `vX.Y.Z — <summary>`), push the tag (it redeploys, so the header shows
  the clean version), and `gh release create` with that CHANGELOG section
  plus a **Full Changelog** compare link.
- **Keep the wiki current.** User docs live in the GitHub wiki
  (https://github.com/jj358mhz/player_test_harness/wiki, a separate repo:
  `git clone https://github.com/jj358mhz/player_test_harness.wiki.git`).
  When a release changes behaviour users see, update the matching page(s)
  in the same session and push after the release. Same public-repo rules:
  no workspace data, use `player.example.com` style examples. Pages:
  Home, Getting Started, Uplynk Accounts and Channel Sync, Channels
  Dashboard, Signing and Preplay, Using the Player, Latency and Drift, DRM
  Playback, Browser Compatibility, Uplynk Conventions, Troubleshooting,
  Deployment, Development (+ `_Sidebar.md`).
- Commits are authored as `jj358mhz@gmail.com`. Don't touch the old GitLab
  remote (`gitlab`, branch `gitlab-main` locally) — it's kept as-is.

## UI conventions

- Magenta (`--accent`) is the brand: header, links, primary form buttons.
  Filled ▶ play buttons are green (`.button--play`, `--play`); pinned
  channels are gold (`--pin`: ★, card border, the rule after them on the
  dashboard).

## Commands

```bash
uv sync                              # install deps
uv run pytest -q                     # tests (CI runs -v)
uv run ruff check . && uv run ruff format --check .
uv run alembic revision --autogenerate -m "..."   # after model changes
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build   # http://localhost:5051

# Player frontend (frontend/, TypeScript + Vite, Node 24)
npm --prefix frontend ci
npm --prefix frontend run build      # → app/static/player (gitignored); `run dev` = watch
npm --prefix frontend run lint && npm --prefix frontend run typecheck && npm --prefix frontend test
```

Without a build, `/player` says "Player not built"; the Python tests don't
need Node. Biome is the TS
linter/formatter (4-space, single quotes, 100 cols) — run `npx biome check
--write .` in `frontend/` before committing.

Tests need no env setup — `tests/conftest.py` sets env vars and builds a
temp SQLite DB. Useful fixtures: `auth_client` (logged-in admin),
`make_account`, `make_channel`, `ec_keypair`, `FakeSession`/`FakeResponse`
for stubbing `requests`.

CI pins **uv 0.5.11** and **Python 3.12** (`ci.yml`, `Dockerfile`). Local uv
is newer; check lockfile compatibility with `uvx uv@0.5.11 lock --check`
after dependency changes.

## Layout

- `app/uplynk/` — pure Uplynk logic, no Flask request context:
  - `auth.py` — scoped-key ES256 JWT (`X-Auth-Uplynk-Jwt`) and classic
    `msg`/`sig` params (zlib+base64 JSON `{_owner,_timestamp}`, HMAC-SHA256).
  - `channels.py` — `GET /api/v4/channels`; prefers scoped key, falls back
    to classic auth with the account API key. Response list is `items`,
    **max 40 per page** (`page_size` is ignored above 40); walk `page=1..`
    until `total_items`. Allowed params: after, include_deleted, order,
    page, page_size, search, type (+ msg/sig).
  - `playback.py` — URL templates, token signing, Preplay v2 fetch. `_get`
    retries once on a connection/DNS failure and logs it without the query
    (v3.29.1); requests' "Max retries exceeded" text doesn't mean it retried.
  - `params.py` — customization params a load may sign (the Params box).
  - `clock.py` — DASH clock offset: matches MPD `$Number$` slices (per
    Period `AssetIdentifier`) to `pdts=latency` HLS `#UPLYNK-SEGMENT`
    slices. `create_playback` returns it as `clock` for live DASH.
  - `sync.py` — channels → DB upsert; deactivates missing, keeps favorites.
    With `UplynkAccount.sync_events` also `sync_events()`: Live Events
    into the same `channels` table as `kind='event'` (v3.33.0, #86).
  - `events.py` — `GET /api2/liveevents2/list` (classic v2 auth: the params
    go inside the signed `msg`), window `start`/`stop` in UTC ms on
    `expected_start` (`EVENT_SYNC_PAST_HOURS` / `EVENT_SYNC_AHEAD_DAYS`),
    `limit` ≤ 100 + `skip`, no total (a short page ends it).
- `app/api/service.py` — validates playback requests, signs/Preplays,
  writes `PlaybackEvent`, records `Channel.encryption` from the probe
  (`check_encryption()` backs `flask check-encryption`; `check_health()`
  backs `flask check-health`, **Check health** on the dashboard and the
  background check: `pdts=latency` HLS → `app/uplynk/health.py` edge age; bulk probes go through `probe_all`: one `requests.Session` per thread, since a session-less check of ~180 channels got the Pi DNS-rate-limited by Pi-hole, v3.32.3). Both the JSON API and `/channels/<id>/play` use it.
- `app/main/` — pages: channels dashboard, `/player`, `/compare`, `/sign`, `/activity`.
  `/channels/by-slicer/<slicer>` is csl-slicer-console's way in; we link
  to its `/slicers/by-id/<slicer>` when `CSL_BASE_URL` is set (console
  side: `PLAYER_BASE_URL`, v1.16.0). `/player` renders `main/player.html` with a JSON
  config (channels, endpoints; never keys) and the Vite assets found by
  `app/vite.py`. `/channels/<id>/play` → `/player?channel=<id>`.
- `app/engines.py` — engine version menu from npm (latest patch of the last
  3 minors, cached 24 h), served at `/api/engines/<pkg>/versions`.
- `frontend/src/` — the player:
  - `app.ts` — page controller: load bar, vitals, timeline, inspector tabs.
  - `engines/types.ts` — `PlayerEngine` interface + events; `engines/hlsjs.ts`
    loads any hls.js version from jsDelivr (`dist/hls.mjs`); `engines/shaka.ts`
    loads Shaka's UMD build with a `<script>` tag (`window.shaka`) and does
    DASH + Widevine/PlayReady; `engines/dashjs.ts` imports dash.js's ESM
    build (`dist/modern/esm/dash.all.min.js`, v5+), request timing via
    `addResponseInterceptor`, license timing KEY_MESSAGE →
    LICENSE_REQUEST_COMPLETE (protection events by name, e.g.
    `public_keyMessage`); `engines/native.ts` is `video.src` (Safari),
    with its own master fetch for the ladder and an optional `limits`
    note; given a `FairPlayConfig` it also does FairPlay with EME
    (`lib/fairplay.ts`: skd:// → license URL, SPC/CKC bodies). DRM
    configs are `CencDrmConfig` (Shaka, dash.js) or `FairPlayConfig`. dash.js `reset()` clears `video.autoplay`/`muted`; the adapter
    restores them. npm dependencies give types and defaults (dash.js's
    version is read from `frontend/package.json`, it doesn't export its own).
    `destroy()` is async: await it before attaching the next engine.
    `window.playerEngine` is the live engine, for console debugging.
  - `lib/` — pure, unit-tested: `latency.ts` (ID3 latency at the playhead),
    `id3.ts`, `rays.ts` (ray from URI, `#UPLYNK-MEDIA0`, `rays=`),
    `scte35.ts` (splice_insert, time_signal, segmentation descriptors),
    `clock.ts` (which clock program dates use; `delay=` parsing),
    `bands.ts`, `stats.ts`, `cmcd.ts` (CMCD param parsing, ids),
    `mp4.ts` (prft/tfdt/mdhd from DASH segments → encoder-time anchors
    for the same clock ID3 uses; emsg payload preview),
    `waterfall.ts` (request detail; first byte from the engine or Resource Timing),
    `jumps.ts` (labels playhead jumps: GAP JUMP / JUMP TO LIVE / SEEK, v3.28.0),
    `mpdTail.ts` (newest Periods vs the playhead, logged at DASH stalls, v3.29.0),
    `xml.ts` (`prettyXml`: the MPD indented in the Manifest tab, v3.32.0),
    (`ui/charts.ts` `drawBufferChart`: buffer/bandwidth/stalls under the timeline, v3.30.0),
    `uplynkParams.ts` (the Params box: + param menu, accepted keys/families,
    refused keys; `app/uplynk/params.py` mirrors it for presets and
    `tests/test_uplynk_params.py` checks they match),
    `deeplink.ts` (address bar ⇄ load bar; validates
    engine versions because they end up in a jsDelivr URL).
  - `compare.ts` — third Vite entry, `/compare`: two `/player?embed=1`
    iframes (embed = no site header, compat panel or Copy link). Reads
    each through `window.playerApp.snapshot()` (same origin) once a
    second; `lib/compare.ts` has presets, `?a=&b=` links (each pane query
    goes through `parseView`) and B − A. Iframes, not two controllers in
    one page: Shaka's UMD build is a global, and `PlayerApp` owns
    `location`/`history`.
  - Feature reference for users: `docs/player.md`.
- `app/sessions.py` — recorded sessions: validate, redact (`sig=`, `pbs=`,
  percent-encoded forms, `/preplay2/…/<session>` paths, license URL
  queries), store, prune. The browser redacts too (`lib/recording.ts`);
  keep both lists in step. Page `/sessions/<slug>` embeds the JSON with
  `|tojson` and draws it with `frontend/src/recording.ts` (second Vite
  entry; `app/vite.py` collects CSS from imported chunks).
- `app/admin/` — Uplynk account CRUD + sync (admin-only).
- `app/presets.py` — saved engine presets (`EnginePreset`): a deep-link
  query without `src`/rays (an optional `channel=<id>`, checked to exist),
  re-validated server-side with the
  deeplink.ts rules (versions go into jsDelivr URLs); `/api/presets`
  GET/POST (same name replaces)/DELETE; listed in the player's config.
  v3.23.0: `/presets` page (`main/presets.html`: list with `describe()`,
  add/edit/rename via `query_from_form()`, delete; **Open in player** =
  `/player?preset=<id>` → config `initialPreset`).
- `app/csl.py` — csl-slicer-console settings lookup (slicer `wallclock`), cached 5 min.
- `app/autosync.py` — background channel sync, started per worker by
  gunicorn's `post_worker_init`; one worker syncs (flock on a temp file).
  Never started by the CLI or tests. **Env vars reach the container only
  if `docker-compose.yml` lists them**: add new settings there too.

## Uplynk facts we rely on

- Token: `tc=1&exp=<unix>&rn=<rand>&ct=<a|c|e|p>&cid=<guid>` (or
  `eid=<ext>&oid=<owner>`), then any customization params, then
  `&sig=` = HMAC-SHA256(api_key, query-before-sig). Every param before `sig`
  is signed, including Preplay's `manifest` and `rmt`. `exp` ≥ now+10s.
- Playback: `content.uplynk.com/channel/<id>.{m3u8,mpd}`,
  `/channel/ext/<owner>/<ext>.*`, assets at `/<id>.*`, events at `/event/<id>.*`.
- Preplay v2: `/preplay/channel/<id>.json` (channels), `/preplay/<id>.json`
  (assets) and, undocumented, `/preplay/event/<id>.json` (events, v3.35.0). Response: absolute `playURL`, `prefix`, `sid`, `drm`
  (`widevineLicenseURL`, `playreadyLicenseURL`, `fairplayCertificateURL`, `required`).
- Rays: Uplynk names renditions by letter, `a` = lowest. In an HLS master
  each variant URI's basename is the ray (`…/channel/<id>/e.m3u8`; `ifo` is
  the I-frame playlist), preceded by `#UPLYNK-MEDIA0:<W>x<H>x<fps>,<profile-level>,<ch>x<rate>`.
  The signed `rays=` param restricts playback to a set (e.g. `rays=fed`).
  Always label renditions with their ray in the UI.
- DASH (Preplay `manifest=mpd`): video Representation `id` is the ray in
  upper case (`A`…`H`), audio is `m`; segment files start with the ray
  letter (`D00003391.m4f`, `F_init.mp4`); FairPlay HLS segments are
  `FP_<RAY>…`. Ads are separate Periods with `AssetIdentifier
  urn:com:uplynk:ad-asset-id`; `InbandEventStream com.uplynk.asset.metadata`:
  each emsg is an ID3v2.4 tag (the same ID3 as HLS): a TXXX with no
  description, `<asset id>_<ray>_<slice, 8 hex>`, plus on `wallclock: 1`
  slicers a TXXX `wallclock` = ISO time without a zone (UTC). Segments carry
  **no `prft`** (checked 2026-10-19), so DASH encoder latency comes from
  that ID3's wallclock TXXX (slicers with `wallclock: 1`).
- Encryption shows only in **media** playlists, not the master: the probe
  follows the first variant. Nearly every Uplynk channel is `AES-128`
  (the default, so no badge); Studio DRM ones carry FairPlay keys.
  **Ad slices are AES-128 even on Studio DRM channels** (2026-10-22): a
  window of only `#UPLYNK-SEGMENT` kind `ad` gives no verdict, and `drm`
  is sticky: only `flask check-encryption` downgrades it (v3.27.3).
  Preplay's `drm.required` was `false` on those DRM channels, so it's no
  signal. **Some Studio DRM channels list AES-128 keys, not FairPlay**
  (`/check2?b,c,pbs,r,v`): ad keys are served, content keys get `400 DRM
  disallows raw key request` (server or browser alike). `probe_manifest`
  fetches the newest content segment's key when it sees AES-128
  (`content_key_uri`, v3.27.4) and calls that refusal `drm`.
- Studio DRM channels: plain signed HLS is FairPlay (`METHOD=SAMPLE-AES`,
  `skd://…/fp-spc/`, `KEYFORMAT="com.apple.streamingkeydelivery"`), Safari
  only. In Chrome use Preplay `manifest=mpd&rmt=wv`: CENC DASH whose license
  URL is `<prefix>/wv` (`/pr` for PlayReady); the MPD also carries it.
- **Uplynk DASH is always CENC**, even without Studio DRM: the MPD carries
  Widevine/PlayReady `ContentProtection` with the license URL in
  `<ms:laurl licenseUrl=…>` (Shaka uses it automatically; dash.js is given
  it). A browser may use a signed DASH URL only once: a second fetch with
  a browser User-Agent gets `403 DRM sig reuse rejected` (server-side
  fetches like the probe don't count). Re-sign rather than replaying.
- FairPlay (docs "Apple FairPlay DRM (HLS)"): Preplay `rmt=fps` →
  `drm.fairplayCertificateURL`; license URL = the `skd://` key URI with
  `https://`; POST JSON `{"spc": base64}` → `{"ckc": base64}`. Segments
  are TS (`FP_<RAY>….ts`): Safari's standard EME never fires `encrypted`
  for TS SAMPLE-AES (seen in Safari: MEDIA_ERR_DECODE, no key request), so
  TS uses legacy `WebKitMediaKeys` (`com.apple.fps.1_0`, `webkitneedkey`,
  init data + content id (skd host) + certificate). Certificate and key
  server hosts allow CORS (verified in Safari 2026-10-19).
- **SSAI needs `ad=<ad configuration name>`** on the playback URL (docs
  "Customize Playback via Parameters"): without it no ads, an unknown name
  stops playback. **`GET /api/v4/ads/servers`** (undocumented; an Uplynk
  dev pointed it out 2026-10-20) lists the configurations: `items` of
  `{@id, @type, name, type, provider}` + `total_items`, classic `msg`/`sig`
  auth works. `name` = the CMS's Ad Configuration Name = the `ad=` value;
  `type` is a label (e.g. a promo carousel type). Each item's `@id` is
  just `/api/v4/ads/servers/` (no id); `/api/v4/ads/servers/<name>` returns
  the same fields, no params. (`/api2/ad/external/get` is about transcoded
  creatives.) Channel sync fills `AdServer` rows from it (v3.25.0,
  `app/ads.py` `sync_ad_servers`: adds new names, keeps hand-set params,
  marks dropped ones `is_listed=False`); names can still be added by hand
  on the account page. **Nothing auto-selects an ad server for a channel**
  (the user's rule): the **Ads** menu starts at None unless a link/preset
  names one. The player's **Ads** menu signs
  `ad=` plus the row's `ad.*` params (v3.21.0). Per-load params such as
  `ad.lib=KOR` (they vary per customer/playback) go in the **Params** box
  (v3.24.0; `parseParams` in uplynkParams.ts / `check_params` in
  `app/uplynk/params.py` share the rules). Deep links and presets carry
  them as themselves after `ad=`
  (v3.22.2; v3.22.0's packed `adp=` is still read, and listed presets are
  re-normalized).
- **Parameter expansion** (`expand=set1,set2`, signed like any param):
  sets are defined on the CMS Parameter Expansion page, no API lists them;
  Uplynk expands them server-side (not `jsonp`, `pbs`, `skip_drm`, `oid`,
  channel `start`/`stop`, `stageplayer`). Typed in the player's **Params**
  box (v3.24.0), whose **+ param** menu is the docs' live-channel list.
- **Preplay rejects `ad.preroll=1`** (only named in passing in the docs,
  under `ad_interval`: "Use `ad.preroll`" for a pre-roll; 2026-10-20): Preplay
  v2 answers `500 Server error, sorry` whenever it's signed (HLS without DRM
  too), while a signed `/channel/<id>.m3u8` with the same params plays the
  preroll. Studio DRM channels need Preplay, so no prerolls there.
  `fetch_preplay` names the signed `ad.*` params on a Preplay 5xx; the
  API returns the signed request as `preplay_request` (on errors too,
  v3.27.2: Advanced… page and the player's `PREPLAY` log line) to share
  with Uplynk.
- **SSAI** (docs "Ad Breaks", "Client-Side Beaconing Using Dynamic Manifest
  Markers", "Ad Verification"): Uplynk stitches ads into each session's
  manifest. DASH: each ad is a Period identified by `AssetIdentifier
  schemeIdUri="urn:com:uplynk:ad-asset-id"`; HLS: `#UPLYNK-SEGMENT` kind.
  Opt-in Dynamic Manifest Markers with signed `ad.timedmeta=1` (+
  `dmm.schemas.break=break_info`): HLS `#EXT-X-DATERANGE`
  `CLASS="urn:uplynk:ad-data:break_info"` (DURATION, base64 JSON X-DATA);
  DASH `EventStream schemeIdUri="urn:uplynk:ad-data:break_info"` inside
  ad Periods (one Event: duration, id, presentationTime, JSON body).
  `ad.sssb=1` turns off server-side beacons. Ad data never uses ID3/emsg.
  Break end: `ad.breakend` (chop/drop), `ad.flex` (seconds an ad may overrun).
- DRM: Widevine/PlayReady need DASH; FairPlay needs HLS. Studio DRM requires
  token-protected playback. License hosts: `content.uplynk.com/{wv,pr}` (use
  the Preplay `prefix` zone to avoid redirects). EME needs HTTPS.
- **Latency clocks** (measured 2026-10-18, see `docs/player.md` "Which
  clock"). `delay=<s>` signing param = seconds behind live (default -1 =
  the channel's latency profile, 60 s unless set); HLS and DASH share the
  same newest slice. HLS masters carry `#EXT-X-START:TIME-OFFSET=0`
  (start at the oldest segment, a window of 8 × 4.096 s). Default HLS
  PDT is per session (first slice = session start): ~5 s low, and an idle
  session falls behind then catches up at ~2.5×. `pdts=latency` = encoder
  time (works with Preplay too); `pdts=slicer` is anchored to the slicer
  session start, useless. The MPD clock (`availabilityStartTime`) is
  synthesised so the newest segment ends ≈ now; it shifts with `delay`,
  is the same for every URL of a channel+delay, and ignores `pdts`. DASH
  `$Number$` = HLS slice number (hex in `#UPLYNK-SEGMENT`) within an asset.
- **ID3 wallclock vs `pdts=latency`** (2026-10-19, one `wallclock: 1`
  channel): the wallclock reads ~one slice (≈ 4 s) more latency than the
  program date, on HLS (72.6 vs 68.2 s, no MPD involved) and DASH (50.4
  vs 46.4 s). Not a player bug: they stamp different points of a slice.
- **ID3 wallclock** (TXXX with a time/wallclock description) is written
  only by slicers with `wallclock: 1`; many of the owner's slicers don't
  have it, so "no wallclock" is normal, not a player bug. For cloud
  slicers the console knows: `app/csl.py` asks its
  `/api/slicers/<id>/settings` (bearer `CSL_API_TOKEN` = console
  `PLAYER_API_TOKEN`, v1.17.0; allowlisted keys only), served to the
  player as `/api/channels/<id>/slicer`. On the Pi, `CSL_API_URL=
  http://csl-slicer-console:5000` (both containers are on `auth-net`).
- **Timing from the browser**: no `Timing-Allow-Origin` on content or CDN
  hosts (Resource Timing has no first byte/connect detail cross-origin);
  segments come from CloudFront (`X-Cache`, `Via`) but `X-Cache`/`Age`
  aren't in `Access-Control-Expose-Headers`. No LL-HLS tags on the channels
  checked (HLS v6, 4.096 s segments).
- **CMCD**: a `CMCD=` query param is fine on signed playlists, MPDs and
  segments (after `sig`). Headers aren't: content.uplynk.com's preflight
  has no `Access-Control-Allow-Headers` and the CDN answers 403.
- **Live Events** (docs "Live Events" API v2, #86): list
  `/api2/liveevents2/list`, one `/api2/liveevents2/get` (`id`/`ids`/
  `external_id(s)`). Answer `{"events": [...], "error": 0}`; fields we use:
  `id`, `external_id`, `desc`, `state`, `expected_start/stop`,
  `actual_start/stop` (ms), `slicers` (`[{owner, id}]`), `require_drm`,
  `require_studio_drm`, `deleted`. Documented `state` values: only
  `complete` seen in the docs; a real workspace's upcoming events say
  `pre` (2026-10-30). The phase (pre / live / ended) comes from
  `actual_start`/`actual_stop` (`Channel.event_phase`). Sync skips ended events (an `actual_stop`), so
  they go inactive like missing ones (v3.33.1). Playback `/event/<id>.{m3u8,mpd}` (`ct=e`) or
  `/event/ext/<owner>/<ext>.*`. **Preplay serves events at
  `/preplay/event/<id>.json`** (not in the docs; checked 2026-10-30: `playURL`
  `/preplay2/event/…`, `prefix`, `sid`, `drm` with `wv`/`pr` license URLs),
  so event DRM goes through Preplay like channels (v3.35.0).
  `/event/<id>.json` is something else: a JSON ray list (`rays`, `pbs`,
  a `__ray__.json` URL). Studio DRM event HLS is FairPlay, pre-event slate too.
  **`fairplayCertificateURL` comes only from workspaces with a FairPlay
  certificate set up** (`x-drm.uplynk.com/fairplay/public_key/<id>.cer`, the
  id isn't the workspace ID); one events workspace returns none, for its DRM
  channels too, so FairPlay can't play there until Uplynk/the customer adds one.
  Health/encryption checks skip events off air (`Channel.checkable()`).
- Docs index: https://docs.uplynk.com/llms.txt

## Deployment

Utility Pi, same as CSL: `deploy.yml` SSHes to the Pi (port 2222), pulls
into `~/git/player_test_harness`, `docker compose up -d --build`. Container
`player-test-harness:5000` on the external `auth-net` network; Caddy block
`player.telcomjj.com` with `import cf_tls` in `homelab-utility/caddy/Caddyfile`.
Secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (repo secrets) and
`.env` on the Pi (`SECRET_KEY`, `FERNET_KEY`, bootstrap admin). SQLite lives
in the `player_harness_data` volume.

## Roadmap / status

- [x] Phase 0 — public GitHub repo, fresh history, scrubbed data
- [x] Phase 1 — backend: accounts, channel sync, signing + Preplay API,
      dashboard, Pi deploy, CI *(PR #1; live at player.telcomjj.com
      2026-10-17, login verified)*
- [x] Phase 2a — player rewrite (2026-10-17): TypeScript + Vite,
      server-only, video-first layout (load bar, video + six vitals,
      5-minute timeline with ad-break shading, tabs: Latency, ABR, DRM &
      keys, Metadata, Tracks, Manifest, Network, Log). Latency at the
      playhead; Current/Avg/Max/Min tiles with the original bands. Rays
      everywhere with `rays=` re-sign. SCTE-35 decode (ID3 PRIV and
      DATERANGE) acted on at playback time; `#UPLYNK-SEGMENT` asset kind.
      Tracks with CEA-608 cues and an audio meter; request waterfall.
      Engine versions: npm latest patch of the last 3 minors + Custom,
      loaded from jsDelivr; default pinned in npm, bumped by Dependabot.
      Classic player deleted.
- [x] Phase 2 — multi-player (v3.5.0): hls.js, Shaka, dash.js, native
      adapters behind `PlayerEngine`. **v3.15.0–3.16.0:** DASH encoder latency
      from in-segment `prft` (`lib/mp4.ts`; Uplynk writes none) and from
      ID3 in emsg (Shaka and dash.js); v3.16.1 asset/ray/slice from that
      ID3. v3.20.1: SSAI ad Periods (`urn:com:uplynk:ad-asset-id`) mark an
      asset as an ad if any identifier in the Period names it; the log
      shows `MPD ADS` / `AD CHECK` lines until a real ad confirms the shape. **v3.17.0:** saved engine presets
      in the DB (load bar **Preset** + **Presets…**). **v3.17.1:** load bar
      = one row of fields + Load, secondary buttons in a toolbar row.
      **v3.23.0:** Preset first; second row = extras a choice asks for
      (custom version, ad params) left, Copy link / Save session / Save as
      preset… right; presets managed on the `/presets` page. **v3.24.0:**
      **Params** box for any synced channel (`expand=` sets, `ad.*`,
      documented Uplynk params) with a grouped **+ param** menu (#57).
      **v3.25.0:** ad servers synced from `/api/v4/ads/servers` with
      channels; dashboard health history reads plain columns.
      **v3.26.0:** a preset may name a channel (`channel=<id>`, optional;
      Presets page menu, player **Include channel**; choosing it selects
      the channel, **Open in player** plays it). Native
      verified in real Safari (2026-10-19: FairPlay, ID3 cues, PDT).
- [~] Phase 3 — DRM. **Done (v3.2.0):** Shaka engine, Widevine/PlayReady
      over DASH from Preplay, DRM panel (key system, license timing/status,
      robustness, expiry, per-key status with HDCP hints), FairPlay-in-Chrome
      message. **v3.4.0:** `Channel.encryption` learned from each HLS probe
      (first media playlist's `EXT-X-KEY`; Preplay `drm.required`), 🔒 DRM
      badge, Widevine auto-selected for DRM channels outside Safari,
      `flask check-encryption`. **v3.13.0–.1:** FairPlay in Safari (Native
      engine, WebKit legacy EME for TS, #21), verified 2026-10-19:
      keys usable, ray f 720p. PlayReady is wired but untested (Chrome has no PlayReady;
      needs Edge).
- [x] Phase 4 — triage (#24, closed; LL-HLS on hold in #48). **Done (v3.6.0):** deep links (source,
      format, engine@version, DRM, rays, tab) + Copy link. **v3.7.0:**
      recorded sessions (`PlaybackSession`, `POST /api/sessions`,
      `/sessions/<slug>` replay via the `recording.ts` Vite entry,
      `SESSION_RETENTION_DAYS`, `flask prune-sessions`). **Left:**
      LL-HLS part/blocking-reload metrics (no channel serves LL-HLS yet).
      **v3.8.0:** latency investigation done: `pdts=latency` for synced
      HLS, DASH clock offset from the server, Delay control, Clock table.
      **v3.9.0:** side-by-side compare (`/compare`), startup time.
      **v3.10.0:** CMCD toggle (query mode), slicer-console links both ways.
      **v3.11.0:** request detail in the waterfall (first byte vs download)
- [x] Periodic background channel sync (v3.12.0, `CHANNEL_SYNC_INTERVAL`)
- [x] Channel health (v3.18.0, `CHANNEL_HEALTH_INTERVAL`): live-edge age per
      channel on the dashboard, run by the auto-sync thread (same lock).
      Edge age at the default delay is ~30 s; behind > 90 s, stale > 300 s
      or `#EXT-X-ENDLIST` (`app/uplynk/health.py`). v3.19.0: every check
      kept in `channel_health_checks` (`HEALTH_HISTORY_DAYS`, pruned per
      run); `app/health_history.py` draws server-side SVG sparklines (card,
      24 h) and `/channels/<id>/health` (24 h + N days, status changes).
      v3.26.1: the dashboard's sparklines are cached per worker until the
      next health run (`health_history.dashboard()`, keyed by the newest
      `health_checked_at` + channel ids; ~1 s → ~0.15 s on the Pi at 178
      channels). Times on cards/table are localized by `app.js` (`time[data-local]`);
      chart axes stay UTC. v3.20.0: `GET /api/health/slicers` (bearer
      `CSL_API_TOKEN`, the same shared secret both ways) feeds health
      badges on csl-slicer-console's slicer cards (console v1.18.0,
      `PLAYER_API_URL`).

- [~] Live events (v3.33.0, #86): opt-in per account, dashboard
      **Events** page (`/events`, header link once enabled; v3.34.1),
      player groups. v3.35.0: event DRM via `/preplay/event/` (FairPlay
      where the workspace has a certificate). **Left:** play a live (not
      pre-event) DRM event end to end.

### Todo

- [x] Own app icon: magenta-gradient play tile in `app/static/favicons/`,
      the header brand mark (`.site-header__brand::before`, was CSL's "C")
      and an inline SVG in the player
- [x] Verify against a real workspace (2026-10-17): sync, signed HLS
      (200 on every channel), Preplay v2. DASH is signed correctly but
      Uplynk answers `400 Non dash asset <id>` when the airing asset has
      no DASH packaging — a content setting, not a signing bug
- [x] Probe the manifest after signing and show Uplynk's error text
      (`probe_manifest` in `app/uplynk/playback.py`; tests stub it via the
      autouse `probe_calls` fixture)
- [x] Review the player UI/structure before Phase 2 → Phase 2a above
- [x] Merge PR #2 (bootstrap race between workers, gunicorn control socket)
- [x] Port to CSL: PR #2 fixes and Dockerfile `LABEL` (csl-slicer-console
      #63, v1.15.3); CSL already had the deploy `concurrency` group
