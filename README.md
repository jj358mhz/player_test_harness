# 📺 player-test-harness

[![Release](https://img.shields.io/github/v/release/jj358mhz/player_test_harness?label=release&color=ec1e79)](https://github.com/jj358mhz/player_test_harness/releases/latest)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

Engineering harness for triaging Uplynk playback. Syncs live channels from
your Uplynk workspaces, signs playback URLs server-side (HLS and DASH, with
Preplay v2 for DRM), and opens them in a monitoring player that tracks
latency, drift, ABR, DRM keys, ID3/SCTE-35, captions and more.

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
- 🔐 **Preplay v2 + DRM** — request Widevine / PlayReady (DASH) or FairPlay
  (HLS) sessions and get back the zone `prefix` and license/certificate URLs.
- ▶️ **One-click play** — each channel card signs a fresh HLS URL and opens
  the monitoring player with it. Copy HLS/DASH buttons for use in other players.
- 📊 **Monitoring player** — the HLS.js Advanced Latency Monitor; see
  [docs/player.md](docs/player.md).
- 📜 **Audit trail** — every signing / Preplay request (base URL and params,
  never the signature) and every account or sync action.

## 🗺️ Roadmap

| Phase | Scope                                                                    | Status  |
|-------|--------------------------------------------------------------------------|---------|
| 0     | Move to GitHub, scrub workspace-specific data                            | ✅ done |
| 1     | Flask backend: accounts, channel sync, signing + Preplay API, Pi deploy  | ✅ done |
| 2     | Multi-player: player adapter interface; hls.js, Shaka, dash.js, native   | planned |
| 3     | DRM playback driven by Preplay; DRM diagnostics panel                    | planned |
| 4     | Triage: recorded sessions, side-by-side compare, LL-HLS metrics, links   | planned |

## 🏗️ Architecture

| Layer            | Tech                                                       |
|------------------|------------------------------------------------------------|
| Web framework    | Flask 3 + Jinja2                                           |
| ORM & migrations | SQLAlchemy 2 + Alembic                                     |
| Auth             | Flask-Login + Flask-WTF (CSRF) + argon2                    |
| Database         | SQLite (single-file, volume-mounted)                       |
| Frontend         | Server-rendered HTML + a little vanilla JS (no build step) |
| Player           | Self-contained HTML + HLS.js (loaded from jsDelivr)        |
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
| `channels`        | Synced live channels (plus local favorite flag)               |
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

Tests and lint (same as CI):

```bash
uv run pytest -v
uv run ruff check .
uv run ruff format --check .
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

- **`.github/workflows/ci.yml`** — `ruff check` + `ruff format --check` +
  `pytest` on every PR and non-main push.
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
│   ├── __init__.py          # App factory + CLI (sync-channels, set-password)
│   ├── config.py            # Env-var config
│   ├── models.py            # SQLAlchemy models
│   ├── crypto.py            # Fernet helpers
│   ├── admin/               # Uplynk account CRUD + sync
│   ├── api/                 # /api/playback, /api/channels + playback service
│   ├── auth/                # Login / logout / argon2
│   ├── main/                # Channels dashboard, player, sign tool, activity
│   ├── player/              # The monitoring player (standalone HTML)
│   ├── uplynk/
│   │   ├── auth.py          # Scoped JWT + classic msg/sig auth
│   │   ├── channels.py      # v4 channels client
│   │   ├── playback.py      # URL building, token signing, Preplay v2
│   │   ├── scoped_env.py    # Scoped key .env parser
│   │   └── sync.py          # Channels → DB upsert
│   ├── static/              # CSS + JS
│   └── templates/
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
