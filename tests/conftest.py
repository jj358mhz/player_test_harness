"""Shared pytest fixtures."""

from __future__ import annotations

import base64

import pytest
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec


@pytest.fixture
def app(monkeypatch, tmp_path):
    """Create a Flask app configured for tests with a temp SQLite DB."""
    monkeypatch.setenv("SECRET_KEY", "test-secret-key")
    monkeypatch.setenv("FERNET_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path}/test.db")
    monkeypatch.setenv("BOOTSTRAP_ADMIN_EMAIL", "test@example.com")
    monkeypatch.setenv("BOOTSTRAP_ADMIN_PASSWORD", "test-password-123")
    monkeypatch.setenv("WTF_CSRF_ENABLED", "false")

    from app import create_app
    from app.bootstrap import bootstrap_admin
    from app.models import db

    flask_app = create_app()
    with flask_app.app_context():
        db.create_all()
        # Now that tables exist, run bootstrap explicitly (create_app's call
        # earlier was a no-op because the schema wasn't there yet).
        bootstrap_admin(flask_app)
        yield flask_app
        db.session.remove()
        db.drop_all()


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture(scope="module")
def ec_keypair():
    """Generate a real ES256 keypair for signing test JWTs."""
    private_key = ec.generate_private_key(ec.SECP256R1())
    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_key = private_key.public_key()
    return {
        "private_b64": base64.b64encode(pem).decode(),
        "public_key": public_key,
    }


@pytest.fixture
def auth_client(client):
    """A test client logged in as the bootstrap admin."""
    response = client.post(
        "/auth/login",
        data={"email": "test@example.com", "password": "test-password-123"},
    )
    assert response.status_code == 302
    return client


@pytest.fixture
def make_account(app):
    """Factory for UplynkAccount rows with an encrypted API key."""
    from app.crypto import encrypt
    from app.models import UplynkAccount, db

    def _make(label="demo", workspace_id="owner123", api_key="secret-api-key", **kwargs):
        acct = UplynkAccount(
            label=label,
            workspace_id=workspace_id,
            api_key_encrypted=encrypt(api_key),
            **kwargs,
        )
        db.session.add(acct)
        db.session.commit()
        return acct

    return _make


@pytest.fixture
def make_channel(app):
    """Factory for Channel rows."""
    from app.models import Channel, db

    def _make(account, channel_id="chan0001", **kwargs):
        kwargs.setdefault("description", f"Channel {channel_id}")
        channel = Channel(uplynk_account_id=account.id, channel_id=channel_id, **kwargs)
        db.session.add(channel)
        db.session.commit()
        return channel

    return _make


class FakeResponse:
    """Minimal stand-in for requests.Response."""

    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text or (str(payload) if payload is not None else "")

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


class FakeSession:
    """Records GETs and returns a canned response."""

    def __init__(self, response):
        self.response = response
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response
