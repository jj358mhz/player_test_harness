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
- Commits are authored as `jj358mhz@gmail.com`. Don't touch the old GitLab
  remote (`gitlab`, branch `gitlab-main` locally) — it's kept as-is.

## Commands

```bash
uv sync                              # install deps
uv run pytest -q                     # tests (CI runs -v)
uv run ruff check . && uv run ruff format --check .
uv run alembic revision --autogenerate -m "..."   # after model changes
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build   # http://localhost:5051
```

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
    to classic auth with the account API key. Response list is `items`.
  - `playback.py` — URL templates, token signing, Preplay v2 fetch.
  - `sync.py` — channels → DB upsert; deactivates missing, keeps favorites.
- `app/api/service.py` — validates playback requests, signs/Preplays,
  writes `PlaybackEvent`. Both the JSON API and `/channels/<id>/play` use it.
- `app/main/` — pages: channels dashboard, `/player`, `/sign`, `/activity`.
- `app/admin/` — Uplynk account CRUD + sync (admin-only).
- `app/player/hls-id3-player.html` — the monitoring player, a single
  ~7k-line self-contained file served by `main.player` behind login.
  `?src=<url>` autoloads. Must keep working standalone (opened from disk).

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
- [ ] Phase 2 — multi-player: split the player into ES modules (no build
      step), `PlayerAdapter` interface (hls.js, Shaka, dash.js, native);
      per-engine latency source (ID3 wallclock for HLS; emsg/prft/UTCTiming
      for DASH). Presets move into the DB.
- [ ] Phase 3 — DRM playback from Preplay `drm` config; DRM panel (key
      system, license latency/status, robustness, key/HDCP errors)
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
- [ ] Probe the manifest after signing and show Uplynk's error text
      (e.g. `Non dash asset`) instead of a silent failed download
- [ ] Merge PR #2 (bootstrap race between workers, gunicorn control socket)
- [ ] Port PR #2 fixes and the Dockerfile `LABEL` (deploy image prune) to CSL
