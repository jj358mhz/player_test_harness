"""Flask application factory."""

from __future__ import annotations

import logging
import os

import click
from flask import Flask
from flask_login import LoginManager
from flask_wtf.csrf import CSRFProtect

from app.bootstrap import bootstrap_admin
from app.config import Config
from app.models import User, db

APP_VERSION = os.getenv("APP_VERSION", "dev")

login_manager = LoginManager()
login_manager.login_view = "auth.login"
login_manager.login_message = "Please sign in to access that page."
login_manager.login_message_category = "info"

csrf = CSRFProtect()


@login_manager.user_loader
def load_user(user_id: str) -> User | None:
    return db.session.get(User, int(user_id))


def create_app(config: Config | None = None) -> Flask:
    """Create and configure the Flask application."""
    app = Flask(__name__, instance_relative_config=False)
    app.config.from_object(config or Config())

    _configure_logging(app)

    db.init_app(app)
    login_manager.init_app(app)
    csrf.init_app(app)

    from app.admin import bp as admin_bp
    from app.api import bp as api_bp
    from app.auth import bp as auth_bp
    from app.main import bp as main_bp

    app.register_blueprint(main_bp)
    app.register_blueprint(auth_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(api_bp)

    @app.context_processor
    def inject_version() -> dict:
        return {"app_version": APP_VERSION, "csl_base_url": app.config["CSL_BASE_URL"]}

    _register_cli(app)

    # First-run bootstrap (idempotent — skips if users already exist)
    bootstrap_admin(app)

    app.logger.info("player-test-harness started (env=%s)", app.config.get("ENV", "?"))
    return app


def _register_cli(app: Flask) -> None:
    @app.cli.command("sync-channels")
    @click.option("--account", "label", help="Only sync the account with this label.")
    def sync_channels(label: str | None) -> None:
        """Sync live channels from Uplynk for all (or one) accounts."""
        from app.models import UplynkAccount
        from app.uplynk.sync import sync_account

        query = db.session.query(UplynkAccount).order_by(UplynkAccount.label)
        if label:
            query = query.filter_by(label=label)
        accounts = query.all()
        if not accounts:
            raise click.ClickException("No matching Uplynk accounts.")
        failed = False
        for acct in accounts:
            result = sync_account(acct)
            failed = failed or bool(result.error)
            click.echo(result.summary)
        if failed:
            raise SystemExit(1)

    @app.cli.command("check-encryption")
    @click.option("--account", "label", help="Only check the account with this label.")
    def check_encryption_cmd(label: str | None) -> None:
        """Probe each active channel's HLS and record its encryption (DRM badge)."""
        from app.api.service import check_encryption
        from app.models import Channel, UplynkAccount

        query = db.session.query(Channel).filter_by(is_active=True).join(UplynkAccount)
        if label:
            query = query.filter(UplynkAccount.label == label)
        channels = query.order_by(UplynkAccount.label, Channel.description).all()
        if not channels:
            raise click.ClickException("No matching channels.")
        counts: dict[str, int] = {}
        for channel, probe in check_encryption(channels):
            state = probe.encryption or ("unknown" if probe.ok else "failed")
            counts[state] = counts.get(state, 0) + 1
            if not probe.ok:
                click.echo(f"  {channel.display_name}: {probe.error}")
        click.echo(", ".join(f"{n} {state}" for state, n in sorted(counts.items())))

    @app.cli.command("prune-sessions")
    @click.option("--days", type=int, help="Override SESSION_RETENTION_DAYS for this run.")
    def prune_sessions_cmd(days: int | None) -> None:
        """Delete recorded sessions older than the retention period."""
        from app.sessions import prune_sessions

        click.echo(f"Deleted {prune_sessions(days)} recorded sessions.")

    @app.cli.command("set-password")
    @click.argument("email")
    @click.password_option()
    def set_password(email: str, password: str) -> None:
        """Reset a user's password."""
        from app.auth.passwords import hash_password

        user = db.session.query(User).filter_by(email=email.lower().strip()).first()
        if user is None:
            raise click.ClickException(f"No user {email!r}")
        user.password_hash = hash_password(password)
        db.session.commit()
        click.echo(f"Password updated for {user.email}")


def _configure_logging(app: Flask) -> None:
    """Send Flask logs to stdout at the configured level."""
    level_name = os.getenv("LOG_LEVEL", "info").upper()
    level = getattr(logging, level_name, logging.INFO)

    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("[%(asctime)s] %(levelname)s in %(name)s: %(message)s"))
    app.logger.handlers.clear()
    app.logger.addHandler(handler)
    app.logger.setLevel(level)
