"""Background channel sync: who's due, what gets logged, one runner per host."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app import autosync
from app.models import AdminEvent, db
from app.uplynk.sync import SyncResult

NOW = datetime(2026, 10, 18, 12, 0, tzinfo=UTC)


def fake_sync(results):
    """Stub sync_account: returns the next canned result and stamps success."""

    def _sync(account):
        r = results.pop(0)
        r.account_id, r.account_label = account.id, account.label
        if not r.error:
            account.last_synced_at = NOW
        db.session.commit()
        return r

    return _sync


def test_only_due_accounts_sync(app, make_account, monkeypatch):
    fresh = make_account(label="fresh")
    fresh.last_synced_at = NOW - timedelta(minutes=10)
    stale = make_account(label="stale")
    stale.last_synced_at = NOW - timedelta(minutes=90)
    make_account(label="never")
    db.session.commit()
    monkeypatch.setattr(autosync, "sync_account", fake_sync([SyncResult(0, ""), SyncResult(0, "")]))

    ran = autosync.run_due(app, now=NOW)
    assert [r.account_label for r in ran] == ["never", "stale"]  # never-synced first


def test_logs_only_changes_and_failures(app, make_account, monkeypatch):
    make_account(label="a")
    make_account(label="b")
    make_account(label="c")
    results = [SyncResult(0, "", created=2), SyncResult(0, ""), SyncResult(0, "", error="HTTP 401")]
    monkeypatch.setattr(autosync, "sync_account", fake_sync(results))

    autosync.run_due(app, now=NOW)
    events = db.session.query(AdminEvent).order_by(AdminEvent.id).all()
    assert [(e.target, e.action) for e in events] == [("a", "auto"), ("c", "error")]
    assert all(e.summary.startswith("Auto-sync: ") and e.actor_id is None for e in events)


def test_logs_event_changes(app, make_account, monkeypatch):
    from app.uplynk.sync import EventSyncResult

    for label in "abcde":
        make_account(label=label)
    results = [
        SyncResult(0, "", events=EventSyncResult(created=1)),
        SyncResult(0, "", events=EventSyncResult(updated=3)),  # nothing new: quiet
        SyncResult(0, "", events=EventSyncResult(updated=1, started=1)),
        SyncResult(0, "", events=EventSyncResult(deactivated=2)),
        SyncResult(0, "", event_error="Uplynk API error: nope"),
    ]
    monkeypatch.setattr(autosync, "sync_account", fake_sync(results))

    autosync.run_due(app, now=NOW)
    events = db.session.query(AdminEvent).order_by(AdminEvent.id).all()
    assert [e.target for e in events] == ["a", "c", "d", "e"]
    assert "1 went live" in events[1].summary
    assert "live events not synced" in events[3].summary


def test_failed_account_waits_before_retrying(app, make_account, monkeypatch):
    make_account(label="broken")
    calls = []

    def failing(account):
        calls.append(account.label)
        return SyncResult(account.id, account.label, error="boom")

    monkeypatch.setattr(autosync, "sync_account", failing)
    failed: dict[int, datetime] = {}
    autosync.run_due(app, now=NOW, failed=failed)
    autosync.run_due(app, now=NOW + timedelta(minutes=1), failed=failed)  # too soon
    autosync.run_due(app, now=NOW + timedelta(minutes=6), failed=failed)
    assert calls == ["broken", "broken"]


def test_interval_zero_turns_it_off(app, make_account, monkeypatch):
    app.config["CHANNEL_SYNC_INTERVAL"] = 0
    app.config["CHANNEL_HEALTH_INTERVAL"] = 0
    make_account()
    monkeypatch.setattr(autosync, "sync_account", lambda a: (_ for _ in ()).throw(AssertionError))
    assert autosync.run_due(app, now=NOW) == []
    assert autosync.start(app) is None


def test_one_lock_holder(tmp_path):
    path = str(tmp_path / "lock")
    first = autosync.try_lock(path)
    assert first is not None
    assert autosync.try_lock(path) is None  # a second worker can't take it
    first.close()  # the holder exits
    again = autosync.try_lock(path)
    assert again is not None
    again.close()


def test_accounts_page_shows_interval(auth_client, app):
    assert "every 60 min" in auth_client.get("/admin/uplynk-accounts").get_data(as_text=True)
    app.config["CHANNEL_SYNC_INTERVAL"] = 0
    assert "Automatic sync is off" in auth_client.get("/admin/uplynk-accounts").get_data(
        as_text=True
    )


def test_gunicorn_hook_starts_autosync(monkeypatch):
    import importlib.util
    from pathlib import Path

    spec = importlib.util.spec_from_file_location(
        "gconf", Path(__file__).parent.parent / "gunicorn.conf.py"
    )
    gconf = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gconf)
    started = []
    monkeypatch.setattr(autosync, "start", started.append)
    worker = type("W", (), {"wsgi": "the-app"})()
    gconf.post_worker_init(worker)
    assert started == ["the-app"]
