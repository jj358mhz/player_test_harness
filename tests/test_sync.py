"""Tests for channel sync into the database."""

from __future__ import annotations

import pytest

from app.models import Channel, db
from app.uplynk import sync as sync_module
from app.uplynk.channels import DiscoveredChannel, UplynkAPIError


def _dc(channel_id, desc="Desc", **kwargs):
    defaults = dict(external_id=None, slicer_id=None, thumb_url=None, use_chsched=1, created=None)
    defaults.update(kwargs)
    return DiscoveredChannel(channel_id=channel_id, description=desc, **defaults)


class StubClient:
    def __init__(self, channels=None, error=None, auth_mode="classic"):
        self.channels = channels or []
        self.error = error
        self.auth_mode = auth_mode

    def list_channels(self):
        if self.error:
            raise self.error
        return self.channels


@pytest.fixture
def stub_client(monkeypatch):
    holder = {}

    def install(client):
        holder["client"] = client
        monkeypatch.setattr(sync_module, "build_client", lambda account: client)

    return install


def test_sync_creates_updates_and_deactivates(app, make_account, make_channel, stub_client):
    acct = make_account()
    kept = make_channel(acct, "keep", description="Old name", is_favorite=True)
    make_channel(acct, "gone")

    stub_client(StubClient([_dc("keep", "New name", slicer_id="s1"), _dc("new1")]))
    result = sync_module.sync_account(acct)

    assert (result.created, result.updated, result.deactivated) == (1, 1, 1)
    assert result.error is None
    assert "classic auth" in result.summary

    db.session.refresh(kept)
    assert kept.description == "New name"
    assert kept.slicer_id == "s1"
    assert kept.is_favorite  # user state survives sync
    gone = db.session.query(Channel).filter_by(channel_id="gone").one()
    assert not gone.is_active
    assert acct.last_synced_at is not None
    assert acct.last_sync_error is None


def test_sync_reactivates_returning_channel(app, make_account, make_channel, stub_client):
    acct = make_account()
    ch = make_channel(acct, "back", is_active=False)
    stub_client(StubClient([_dc("back")]))
    sync_module.sync_account(acct)
    db.session.refresh(ch)
    assert ch.is_active


def test_sync_records_error_without_touching_channels(app, make_account, make_channel, stub_client):
    acct = make_account()
    ch = make_channel(acct, "keep")
    stub_client(StubClient(error=UplynkAPIError("rejected (401)")))

    result = sync_module.sync_account(acct)

    assert result.error == "rejected (401)"
    assert "Sync failed" in result.summary
    db.session.refresh(ch)
    assert ch.is_active
    assert acct.last_sync_error == "rejected (401)"
    assert acct.last_synced_at is None


def test_sync_isolated_per_account(app, make_account, make_channel, stub_client):
    a = make_account("a")
    b = make_account("b")
    other = make_channel(b, "b-only")
    stub_client(StubClient([_dc("a-only")]))
    sync_module.sync_account(a)
    db.session.refresh(other)
    assert other.is_active


def test_build_client_uses_scoped_key_when_present(app, make_account, ec_keypair):
    from app.crypto import encrypt

    acct = make_account(
        scoped_kid="kid",
        scoped_sub="sub",
        scoped_private_b64_encrypted=encrypt(ec_keypair["private_b64"]),
        scoped_scp="video.services.channels:read",
    )
    assert sync_module.build_client(acct).auth_mode == "scoped"
    assert sync_module.build_client(make_account("plain")).auth_mode == "classic"


def test_cli_sync_channels(app, make_account, stub_client):
    make_account()
    stub_client(StubClient([_dc("c1")]))
    result = app.test_cli_runner().invoke(args=["sync-channels"])
    assert result.exit_code == 0
    assert "1 new" in result.output


def test_cli_sync_channels_exits_nonzero_on_error(app, make_account, stub_client):
    make_account()
    stub_client(StubClient(error=UplynkAPIError("nope")))
    result = app.test_cli_runner().invoke(args=["sync-channels"])
    assert result.exit_code == 1
    assert "nope" in result.output
