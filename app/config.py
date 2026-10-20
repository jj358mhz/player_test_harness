"""Application configuration loaded from environment variables."""

from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()  # no-op in Docker; useful for local `flask run` outside container


def _require(name: str) -> str:
    """Read a required env var or raise a clear error."""
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set. Copy .env.example to .env and fill in real values.")
    return value


class Config:
    """Base config — instance attributes so env vars are read fresh at
    each instantiation, which makes testing with monkeypatch reliable."""

    def __init__(self) -> None:
        self.ENV = os.getenv("FLASK_ENV", "production")
        self.SECRET_KEY = _require("SECRET_KEY")
        self.FERNET_KEY = _require("FERNET_KEY")

        self.SQLALCHEMY_DATABASE_URI = os.getenv(
            "DATABASE_URL",
            "sqlite:////app/data/player-test-harness.db",
        )
        self.SQLALCHEMY_TRACK_MODIFICATIONS = False

        self.BOOTSTRAP_ADMIN_EMAIL = os.getenv("BOOTSTRAP_ADMIN_EMAIL", "admin@example.com")
        self.BOOTSTRAP_ADMIN_PASSWORD = os.getenv("BOOTSTRAP_ADMIN_PASSWORD")

        self.UPLYNK_API_BASE = os.getenv("UPLYNK_API_BASE", "https://services.uplynk.com")
        self.UPLYNK_CONTENT_BASE = os.getenv("UPLYNK_CONTENT_BASE", "https://content.uplynk.com")
        self.PLAYBACK_TOKEN_TTL = int(os.getenv("PLAYBACK_TOKEN_TTL", "3600"))
        # Recorded sessions: days to keep (0 = until deleted) and upload cap.
        self.SESSION_RETENTION_DAYS = int(os.getenv("SESSION_RETENTION_DAYS", "30"))
        self.MAX_RECORDING_BYTES = int(os.getenv("MAX_RECORDING_BYTES", str(8 * 1024 * 1024)))
        # Background channel sync, minutes (0 = off; UI, CLI or cron only).
        self.CHANNEL_SYNC_INTERVAL = int(os.getenv("CHANNEL_SYNC_INTERVAL", "60"))
        # Background health check of every active channel, minutes (0 = off).
        self.CHANNEL_HEALTH_INTERVAL = int(os.getenv("CHANNEL_HEALTH_INTERVAL", "10"))
        # Days of health checks to keep for the history charts.
        self.HEALTH_HISTORY_DAYS = int(os.getenv("HEALTH_HISTORY_DAYS", "7"))
        # csl-slicer-console, for links from a channel to its slicer (empty = no links).
        self.CSL_BASE_URL = os.getenv("CSL_BASE_URL", "").strip().rstrip("/")
        # Its settings API (slicer wallclock), server to server: the URL this
        # container reaches it at (default CSL_BASE_URL) and the shared token.
        self.CSL_API_URL = (os.getenv("CSL_API_URL", "").strip() or self.CSL_BASE_URL).rstrip("/")
        self.CSL_API_TOKEN = os.getenv("CSL_API_TOKEN", "").strip()

        self.WTF_CSRF_ENABLED = os.getenv("WTF_CSRF_ENABLED", "true").lower() == "true"
