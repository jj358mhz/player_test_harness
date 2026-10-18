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
- Commits are authored as `jj358mhz@gmail.com`. Don't touch the old GitLab
  remote (`gitlab`, branch `gitlab-main` locally) — it's kept as-is.

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
  - `playback.py` — URL templates, token signing, Preplay v2 fetch.
  - `sync.py` — channels → DB upsert; deactivates missing, keeps favorites.
- `app/api/service.py` — validates playback requests, signs/Preplays,
  writes `PlaybackEvent`. Both the JSON API and `/channels/<id>/play` use it.
- `app/main/` — pages: channels dashboard, `/player`, `/sign`, `/activity`. `/player` renders `main/player.html` with a JSON
  config (channels, endpoints; never keys) and the Vite assets found by
  `app/vite.py`. `/channels/<id>/play` → `/player?channel=<id>`.
- `app/engines.py` — engine version menu from npm (latest patch of the last
  3 minors, cached 24 h), served at `/api/engines/<pkg>/versions`.
- `frontend/src/` — the player:
  - `app.ts` — page controller: load bar, vitals, timeline, inspector tabs.
  - `engines/types.ts` — `PlayerEngine` interface + events; `engines/hlsjs.ts`
    loads any hls.js version from jsDelivr (`dist/hls.mjs`); `engines/shaka.ts`
    loads Shaka's UMD build with a `<script>` tag (`window.shaka`) and does
    DASH + Widevine/PlayReady. npm dependencies give types and defaults.
    `destroy()` is async: await it before attaching the next engine.
    `window.playerEngine` is the live engine, for console debugging.
  - `lib/` — pure, unit-tested: `latency.ts` (ID3 latency at the playhead),
    `id3.ts`, `rays.ts` (ray from URI, `#UPLYNK-MEDIA0`, `rays=`),
    `scte35.ts` (splice_insert, time_signal, segmentation descriptors),
    `bands.ts`, `stats.ts`.
  - Feature reference for users: `docs/player.md`.
- `app/admin/` — Uplynk account CRUD + sync (admin-only).

## Uplynk facts we rely on

- Token: `tc=1&exp=<unix>&rn=<rand>&ct=<a|c|e|p>&cid=<guid>` (or
  `eid=<ext>&oid=<owner>`), then any customization params, then
  `&sig=` = HMAC-SHA256(api_key, query-before-sig). Every param before `sig`
  is signed, including Preplay's `manifest` and `rmt`. `exp` ≥ now+10s.
- Playback: `content.uplynk.com/channel/<id>.{m3u8,mpd}`,
  `/channel/ext/<owner>/<ext>.*`, assets at `/<id>.*`, events at `/event/<id>.*`.
- Preplay v2: `/preplay/channel/<id>.json` (channels) and `/preplay/<id>.json`
  (assets); not events. Response: absolute `playURL`, `prefix`, `sid`, `drm`
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
  urn:com:uplynk:ad-asset-id`; `InbandEventStream com.uplynk.asset.metadata`.
- Studio DRM channels: plain signed HLS is FairPlay (`METHOD=SAMPLE-AES`,
  `skd://…/fp-spc/`, `KEYFORMAT="com.apple.streamingkeydelivery"`), Safari
  only. In Chrome use Preplay `manifest=mpd&rmt=wv`: CENC DASH whose license
  URL is `<prefix>/wv` (`/pr` for PlayReady); the MPD also carries it.
- DRM: Widevine/PlayReady need DASH; FairPlay needs HLS. Studio DRM requires
  token-protected playback. License hosts: `content.uplynk.com/{wv,pr}` (use
  the Preplay `prefix` zone to avoid redirects). EME needs HTTPS.
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
- [ ] Phase 2 — multi-player: more `PlayerEngine` adapters (Shaka, dash.js, native);
      per-engine latency source (ID3 wallclock for HLS; emsg/prft/UTCTiming
      for DASH). Presets move into the DB.
- [~] Phase 3 — DRM. **Done (v3.2.0):** Shaka engine, Widevine/PlayReady
      over DASH from Preplay, DRM panel (key system, license timing/status,
      robustness, expiry, per-key status with HDCP hints), FairPlay-in-Chrome
      message. **Next:** FairPlay in Safari (SPC/CKC exchange with
      `fairplayCertificateURL`), DRM badge on dashboard cards. PlayReady is
      wired but untested (Chrome has no PlayReady; needs Edge).
- [ ] Phase 4 — triage: recorded sessions with shareable links (retention
      setting), side-by-side compare, LL-HLS part/blocking-reload metrics,
      CMCD toggle, request waterfall, deep links, CSL cross-link via slicer_id
- [ ] Periodic background channel sync (for now: UI, CLI, or host cron)

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
