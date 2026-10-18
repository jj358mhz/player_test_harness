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
        return {"app_version": APP_VERSION}

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
