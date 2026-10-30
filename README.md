# 📺 player-test-harness

[![Release](https://img.shields.io/github/v/release/jj358mhz/player_test_harness?label=release&color=ec1e79)](https://github.com/jj358mhz/player_test_harness/releases/latest)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

Engineering harness for triaging Uplynk playback. Syncs live channels from
your Uplynk workspaces, signs playback URLs server-side (HLS and DASH, with
Preplay v2 for DRM), and opens them in a monitoring player that tracks
latency, drift, ABR, DRM keys, ID3/SCTE-35, captions and more.

📖 **[Read the wiki](https://github.com/jj358mhz/player_test_harness/wiki)** — getting started, using the player, latency and drift, DRM, browser compatibility, Uplynk conventions and troubleshooting.

## 🌟 Highlights

- 🏢 **Uplynk account management** — register workspaces with their API key
  (signs playback tokens) and an optional Scoped API Key `.env`. All
  credentials are **Fernet-encrypted** at rest; keys never reach the browser.
- 🔄 **Channel sync** — pulls live channels from
  [`GET /api/v4/channels`](https://docs.uplynk.com/reference/get-all-live-channels)
  using the scoped key (JWT) when present, otherwise classic API-key auth.
  One click per account, **Sync all** on the dashboard, or `flask sync-channels`.
- 🔏 **Signed playback** — HMAC-SHA256 tokens per
  [Uplynk's spec](https://docs.uplynk.com/docs/sign-playback-urls-with-a-token):
  channel GUID or external ID, `.m3u8` or `.mpd`, configurable lifetime, and
  extra signed params (`rays`, `delay`, …).
- 🔐 **DRM playback** — Widevine (and PlayReady) over DASH via Preplay v2 and
  Shaka Player, with a DRM panel: license timing and status, key status per
  key (HDCP problems included), robustness and expiry. Studio DRM channels
  get a 🔒 DRM badge and play as Widevine in Chrome, or FairPlay (Native
  engine, EME) in Safari, automatically.
- 📼 **Recorded sessions** — **Save session** in the player keeps what a
  load measured (latency and drift over the whole session, events, log,
  rays, request stats, DRM) at `/sessions/<id>`, redacted of signatures
  and tokens, for `SESSION_RETENTION_DAYS` (default 30). Deep links put the
  whole player view in the address bar.
- 🎛️ **Presets** — named player setups (format, engine and version, DRM,
  delay, ad server and `ad.*` params, CMCD), first in the player's load bar;
  the **Presets** page lists them in plain words, adds, edits and deletes
  them, and opens the player with one applied.
- 🩺 **Channel health** — every `CHANNEL_HEALTH_INTERVAL` minutes (default
  10) the server fetches each channel's `pdts=latency` HLS and measures how
  old the newest segment is on the encoder's clock. Cards get a badge
  (green at the live edge, amber behind, red stale or erroring) and the
  dashboard says how many need attention. Each card has a 24-hour
  sparkline and links to the channel's history page (`HEALTH_HISTORY_DAYS`,
  default 7: charts and status changes). **Check health** runs it now;
  `flask check-health` from the CLI.
- 🎟️ **Live events** — accounts with **Sync live events** also list their
  Live Events (`/api2/liveevents2/list`) on each sync: those expected to
  start from `EVENT_SYNC_PAST_HOURS` ago (default 24) to
  `EVENT_SYNC_AHEAD_DAYS` ahead (default 7). They get their own **Events**
  tab on the dashboard (per account, pre-event / live / ended, schedule)
  and their own group in the player, and play from `/event/<id>.{m3u8,mpd}`.
- ▶️ **One-click play** — each channel card signs a fresh HLS URL and opens
  the monitoring player with it. Copy HLS/DASH buttons for use in other players.
- 📊 **Monitoring player** — video first, with latency (ID3, PDT and
  live-edge drift, measured at the playhead, on the encoder's clock for
  both HLS and DASH; Uplynk `delay=` from the load bar), Uplynk rays, an event
  timeline with ad breaks (SCTE-35 decoded), tracks with an audio meter,
  and a request waterfall. **Compare** puts two players side by side
  (HLS vs DASH, engine vs engine, delay vs delay) with B − A on every
  number. Four engines to compare: **hls.js**, **Shaka
  Player**, **dash.js** and the browser's **native** HLS (Safari). Each npm
  engine offers the latest patch of its last three minor lines. See [docs/player.md](docs/player.md)
  and the [wiki](https://github.com/jj358mhz/player_test_harness/wiki/Using-the-Player).
- 📜 **Audit trail** — every signing / Preplay request (base URL and params,
  never the signature) and every account or sync action.

## 🗺️ Roadmap

| Phase | Scope                                                                    | Status  |
|-------|--------------------------------------------------------------------------|---------|
| 0     | Move to GitHub, scrub workspace-specific data                            | ✅ done |
| 1     | Flask backend: accounts, channel sync, signing + Preplay API, Pi deploy  | ✅ done |
| 2a    | Player rewrite: TypeScript + Vite, video-first layout, rays, versions    | ✅ done |
| 2     | Multi-player: player adapter interface; hls.js, Shaka, dash.js, native   | ✅ done |
| 3     | DRM playback driven by Preplay; DRM diagnostics panel                    | 🟡 Widevine/PlayReady/FairPlay; PlayReady untested |
| 4     | Triage: recorded sessions, side-by-side compare, LL-HLS metrics, links   | ✅ done (LL-HLS on hold, #48) |

## 🏗️ Architecture

| Layer            | Tech                                                       |
|------------------|------------------------------------------------------------|
| Web framework    | Flask 3 + Jinja2                                           |
| ORM & migrations | SQLAlchemy 2 + Alembic                                     |
| Auth             | Flask-Login + Flask-WTF (CSRF) + argon2                    |
| Database         | SQLite (single-file, volume-mounted)                       |
| Frontend         | Server-rendered HTML + a little vanilla JS (no build step) |
| Player           | TypeScript + Vite (`frontend/`); hls.js, Shaka, dash.js from jsDelivr |
| Crypto           | `cryptography` (Fernet at rest, ES256 JWT, HMAC-SHA256)    |
| WSGI server      | gunicorn                                                   |
| Runtime          | Python 3.12 in a slim Debian container                     |
| Package manager  | [uv](https://docs.astral.sh/uv/)                           |
| Reverse proxy    | Caddy (homelab-utility stack) with Cloudflare DNS TLS      |

## 🗂️ Data model

| Table             | Purpose                                                       |
|-------------------|---------------------------------------------------------------|
| `users`           | Login accounts                                                |
| `uplynk_accounts` | Workspaces + encrypted API key / scoped key                   |
| `channels`        | Synced live channels (plus favorite flag, encryption, health) |
| `channel_health_checks` | Every health check, kept `HEALTH_HISTORY_DAYS`          |
| `engine_presets`  | Saved player setups (format, engine@version, DRM, delay, ads, CMCD) |
| `ad_servers`      | SSAI ad configuration names per account (`ad=`), from channel sync or entered by hand |
| `playback_sessions` | Recorded player sessions (redacted)                         |
| `playback_events` | Every signing / Preplay request (no signatures stored)        |
| `admin_events`    | Account CRUD and sync history                                 |

## 🔌 API

Session-authenticated JSON. Send the page's CSRF token in `X-CSRFToken`.

`POST /api/playback`

```jsonc
// a synced channel
{"channel_id": 12, "manifest": "m3u8"}

// anything else, signed with an account's key
{
  "account_id": 1,
  "content_type": "c",          // a | c | e | p
  "content_id": "<guid>",       // or "external_id": "..."
  "manifest": "mpd",            // m3u8 | mpd
  "mode": "preplay",            // url | preplay
  "drm": "wv",                  // wv | pr (mpd) · fps (m3u8) — Preplay only
  "ttl_seconds": 3600,
  "params": {"delay": "10"},    // signed along with the token
  "probe": true                 // default; false skips the manifest check
}
```

Returns `{url, expires_at, mode, manifest, drm, event_id, probe}`; Preplay
adds `prefix`, `sid` and `drm_config` (license/certificate URLs). `probe` is
the result of fetching the signed manifest once — `{ok, status, error,
elapsed_ms}` — so content problems such as `HTTP 400: Non dash asset <id>`
show up immediately instead of as a silent failed download.

`GET /api/channels` lists active synced channels.

`GET /api/health/slicers` (for csl-slicer-console; `Authorization: Bearer
$CSL_API_TOKEN` instead of a login, 404 when unset) returns the latest
health of every channel that has a slicer: `slicer_id`, `channel`, `name`,
`status`, `edge_s`, `detail`, `checked_at`, `health_url`.

## 🧑‍💻 Developing on this repo

Prerequisites: Docker Desktop, [uv](https://docs.astral.sh/uv/), Python 3.12.

```bash
git clone https://github.com/jj358mhz/player_test_harness.git
cd player_test_harness
uv sync

cp .env.example .env
uv run python -c "import secrets; print(secrets.token_urlsafe(32))"   # SECRET_KEY
uv run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"  # FERNET_KEY

# Dev overlay hot-reloads code and runs migrations on start
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
curl http://localhost:5051/health
```

Build the player (Node 24). The Docker image does this itself; locally the
dev overlay serves whatever is in `app/static/player`:

```bash
npm --prefix frontend ci
npm --prefix frontend run dev        # rebuilds on change
```

Tests and lint (same as CI):

```bash
uv run pytest -v
uv run ruff check .
uv run ruff format --check .
npm --prefix frontend run lint
npm --prefix frontend run typecheck
npm --prefix frontend test
```

After changing `app/models.py`, generate a migration:

```bash
uv run alembic revision --autogenerate -m "describe the change"
```

## 🏠 Running your own instance

Docker only — no Caddy, no `auth-net` network:

```bash
git clone https://github.com/jj358mhz/player_test_harness.git
cd player_test_harness
cp .env.example .env
docker build -t player-test-harness:local .
docker run --rm --entrypoint python player-test-harness:local -c "import secrets; print(secrets.token_urlsafe(32))"   # SECRET_KEY
docker run --rm --entrypoint python player-test-harness:local -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"  # FERNET_KEY
# Paste both into .env with your BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD

docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

Sign in at `http://localhost:5051`, add an Uplynk account, then **Sync**.
DRM playback needs a secure context (HTTPS or `localhost`).

**The bootstrap admin is created once, on the first start with an empty
database.** The database lives in a Docker volume that survives rebuilds,
so editing `BOOTSTRAP_ADMIN_EMAIL`/`PASSWORD` later changes nothing (the
log says `BOOTSTRAP_ADMIN_EMAIL/PASSWORD ignored`). If the login says
*Invalid email or password*:

```bash
docker logs player-test-harness 2>&1 | grep -i bootstrap     # created, skipped or ignored?
docker exec player-test-harness python -c "from app import create_app; from app.models import User, db; a=create_app(); a.app_context().push(); print([u.email for u in db.session.query(User)])"
docker exec -it player-test-harness flask --app 'app:create_app()' set-password <email>
```

or start over, deleting the database volume:
`docker compose -f docker-compose.yml -f docker-compose.local.yml down -v`.
In `.env`, write a `$` in the password as `$$` (Compose expands `$`).

## 🚢 Production deployment

Runs on the homelab Utility Pi exactly like
[csl-slicer-console](https://github.com/jj358mhz/csl-slicer-console):
a Docker Compose stack on the shared `auth-net` network, fronted by Caddy at
**player.telcomjj.com** *(LAN / VPN only)*.

### Environment variables

| Variable                   | Purpose                                                       |
|----------------------------|---------------------------------------------------------------|
| `SECRET_KEY`               | Signs Flask session cookies                                   |
| `FERNET_KEY`               | Encrypts Uplynk credentials at rest — back it up              |
| `BOOTSTRAP_ADMIN_EMAIL`    | First-run admin login                                         |
| `BOOTSTRAP_ADMIN_PASSWORD` | First-run admin password                                      |
| `UPLYNK_API_BASE`          | Uplynk API base (default `https://services.uplynk.com`)       |
| `UPLYNK_CONTENT_BASE`      | Playback host (default `https://content.uplynk.com`)          |
| `PLAYBACK_TOKEN_TTL`       | Default signed-token lifetime in seconds (default 3600)       |
| `SESSION_RETENTION_DAYS`   | Days to keep recorded sessions (default 30; 0 = forever)      |
| `CHANNEL_SYNC_INTERVAL`    | Background channel sync, minutes (default 60; 0 = off)        |
| `CHANNEL_HEALTH_INTERVAL`  | Background channel health check, minutes (default 10; 0 = off) |
| `HEALTH_HISTORY_DAYS`      | Days of health checks kept for charts (default 7)              |
| `EVENT_SYNC_PAST_HOURS`    | Live events sync: from this many hours ago (default 24)        |
| `EVENT_SYNC_AHEAD_DAYS`    | Live events sync: to this many days ahead (default 7)          |
| `MAX_RECORDING_BYTES`      | Largest recorded session accepted (default 8 MiB)             |
| `CSL_BASE_URL`             | csl-slicer-console URL for slicer links (optional)            |
| `CSL_API_TOKEN`            | The console's `PLAYER_API_TOKEN`: show slicer wallclock (optional) |
| `CSL_API_URL`              | Where this container reaches the console (default `CSL_BASE_URL`) |
| `LOG_LEVEL`                | `info` / `debug` / `warning`                                  |
| `GUNICORN_WORKERS`         | Worker count (default 2)                                      |

Bootstrap only runs while the `users` table is empty. Reset a password with:

```bash
docker exec -it player-test-harness flask --app app set-password you@example.com
```

Sync channels from cron instead of the UI if you like:

```bash
docker exec player-test-harness flask --app app sync-channels
```

Fill in the 🔒 DRM badges for every channel at once (one HLS probe each;
otherwise they appear as channels are played or checked):

```bash
docker exec player-test-harness flask --app app check-encryption
```

### Caddy routing

In `homelab-utility/caddy/Caddyfile`:

```caddy
player.telcomjj.com {
	import cf_tls
	reverse_proxy player-test-harness:5000
	import security_headers
	log {
		output file /data/logs/player.log {
			roll_size 10mb
			roll_keep 5
		}
		format json
	}
}
```

## ⚙️ CI/CD

- **`.github/workflows/ci.yml`** — on every PR and non-main push: Python
  (`ruff` + `pytest`), frontend (Biome, `tsc`, Vitest, Vite build) and a
  Docker image build.
- **`.github/dependabot.yml`** — weekly npm updates (player engines grouped
  separately from tooling) and monthly GitHub Actions updates.
- **`.github/workflows/deploy.yml`** — on push to `main`, a `v*` tag, or
  manual dispatch: SSH to the Utility Pi, `git pull`, `docker compose up -d
  --build`, prune old images. `git describe` is baked in as `APP_VERSION`
  and shown in the header.

Secrets required for `deploy.yml`: `DEPLOY_HOST`, `DEPLOY_USER`,
`DEPLOY_SSH_KEY`.

## 📁 Repo layout

```
player_test_harness/
├── app/
│   ├── __init__.py          # App factory + CLI (sync-channels, check-encryption, set-password)
│   ├── config.py            # Env-var config
│   ├── models.py            # SQLAlchemy models
│   ├── crypto.py            # Fernet helpers
│   ├── admin/               # Uplynk account CRUD + sync
│   ├── api/                 # /api/playback, /api/channels + playback service
│   ├── auth/                # Login / logout / argon2
│   ├── main/                # Channels dashboard, player, sign tool, activity
│   ├── uplynk/
│   │   ├── auth.py          # Scoped JWT + classic msg/sig auth
│   │   ├── channels.py      # v4 channels client
│   │   ├── playback.py      # URL building, token signing, Preplay v2
│   │   ├── scoped_env.py    # Scoped key .env parser
│   │   └── sync.py          # Channels → DB upsert
│   ├── static/              # CSS + JS
│   └── templates/
├── frontend/                # The player: TypeScript + Vite → app/static/player
│   ├── src/app.ts           # Page controller (load bar, vitals, tabs)
│   ├── src/engines/         # PlayerEngine interface + hls.js, Shaka, dash.js, native
│   ├── src/lib/             # Latency, ID3, rays, bands, stats (unit-tested)
│   └── test/
├── docs/player.md           # Player feature reference
├── migrations/              # Alembic
├── tests/                   # Pytest suite
├── .github/workflows/       # CI + deploy
├── docker-compose.yml       # Production stack (Utility Pi)
├── docker-compose.dev.yml   # Local dev overlay
├── docker-compose.local.yml # Self-host overlay
├── Dockerfile
└── pyproject.toml
```

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Never commit workspace-specific data
(API keys, channel IDs, customer names) — it belongs in the database.

## 📄 License

MIT — see [LICENSE](LICENSE).
