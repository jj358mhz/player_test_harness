"""Tests for admin bootstrap behavior."""

from __future__ import annotations

from app.auth.passwords import verify_password
from app.models import User, db


def test_bootstrap_creates_admin_when_empty(app):
    with app.app_context():
        admin = db.session.query(User).filter_by(email="test@example.com").first()
        assert admin is not None
        assert admin.is_admin is True
        assert admin.is_active is True
        assert verify_password(admin.password_hash, "test-password-123")


def test_bootstrap_is_idempotent(app):
    """Calling create_app again shouldn't create a duplicate admin."""
    from app import create_app

    _ = create_app()  # second call
    with app.app_context():
        count = db.session.query(User).filter_by(email="test@example.com").count()
        assert count == 1


def test_bootstrap_tolerates_concurrent_insert(app, monkeypatch):
    """A second worker that loses the insert race must not crash."""
    from sqlalchemy.orm import Query

    from app.bootstrap import bootstrap_admin

    monkeypatch.setattr(Query, "count", lambda self: 0)  # both workers saw an empty table
    bootstrap_admin(app)
    monkeypatch.undo()
    with app.app_context():
        assert db.session.query(User).filter_by(email="test@example.com").count() == 1


def test_bootstrap_lowercases_email(app, monkeypatch):
    """Login lowercases the email, so a mixed-case bootstrap must too."""
    from app.bootstrap import bootstrap_admin

    with app.app_context():
        db.session.query(User).delete()
        db.session.commit()
    monkeypatch.setitem(app.config, "BOOTSTRAP_ADMIN_EMAIL", "  Jane.Doe@Example.com ")
    bootstrap_admin(app)
    with app.app_context():
        assert [u.email for u in db.session.query(User)] == ["jane.doe@example.com"]

    client = app.test_client()
    resp = client.post(
        "/auth/login",
        data={"email": "Jane.Doe@Example.com", "password": "test-password-123"},
    )
    assert resp.status_code == 302


def test_bootstrap_logs_when_users_exist(app, caplog):
    from app.bootstrap import bootstrap_admin

    with caplog.at_level("INFO"):
        bootstrap_admin(app)
    assert "BOOTSTRAP_ADMIN_EMAIL/PASSWORD ignored" in caplog.text
