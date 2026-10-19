"""Background channel sync every CHANNEL_SYNC_INTERVAL minutes.

Started per gunicorn worker by `post_worker_init` (gunicorn.conf.py), so the
`flask` CLI and the tests never start it. Only the worker holding an
exclusive file lock syncs; the others retry the lock each minute, so if the
syncing worker is restarted another one takes over (the kernel drops the
lock with the process).

An account is due when its last successful sync (manual or automatic) is
older than the interval. Failed accounts are retried on the next pass,
which comes a minute later at the earliest. Runs are logged to Activity
only when something changed or failed.
"""

from __future__ import annotations

import fcntl
import logging
import os
import tempfile
import threading
from datetime import UTC, datetime, timedelta
from typing import IO

from flask import Flask

from app.models import AdminEvent, UplynkAccount, db
from app.uplynk.sync import SyncResult, sync_account

log = logging.getLogger(__name__)

LOCK_PATH = os.path.join(tempfile.gettempdir(), "player-harness-autosync.lock")
#: Seconds between checks, both for the lock and for due accounts.
TICK_SECONDS = 60
#: Failed accounts wait at least this long before the next attempt.
RETRY_AFTER = timedelta(minutes=5)

_started = False
_lock_file: IO[str] | None = None


def interval(app: Flask) -> timedelta | None:
    minutes = app.config["CHANNEL_SYNC_INTERVAL"]
    return timedelta(minutes=minutes) if minutes > 0 else None


def due_accounts(
    every: timedelta, now: datetime, failed: dict[int, datetime]
) -> list[UplynkAccount]:
    """Accounts whose last sync is older than `every` (never-synced ones first)."""
    due = []
    for account in db.session.query(UplynkAccount).order_by(UplynkAccount.id).all():
        last = account.last_synced_at
        if last is not None and last.tzinfo is None:
            last = last.replace(tzinfo=UTC)  # SQLite drops the zone
        if last is not None and now - last < every:
            continue
        if account.id in failed and now - failed[account.id] < RETRY_AFTER:
            continue
        due.append(account)
    return sorted(due, key=lambda a: a.last_synced_at is not None)


def run_due(
    app: Flask, now: datetime | None = None, failed: dict[int, datetime] | None = None
) -> list[SyncResult]:
    """One pass: sync every due account. Returns what ran."""
    every = interval(app)
    if every is None:
        return []
    now = now or datetime.now(UTC)
    failed = {} if failed is None else failed
    results = []
    with app.app_context():
        for account in due_accounts(every, now, failed):
            result = sync_account(account)
            results.append(result)
            if result.error:
                failed[account.id] = now
                log.warning("auto-sync: %s", result.summary)
            else:
                failed.pop(account.id, None)
            if result.error or result.created or result.deactivated:
                db.session.add(
                    AdminEvent(
                        actor_id=None,
                        category="sync",
                        action="error" if result.error else "auto",
                        summary=f"Auto-sync: {result.summary}",
                        target=account.label,
                    )
                )
                db.session.commit()
        db.session.remove()
    return results


def try_lock(path: str = LOCK_PATH) -> IO[str] | None:
    """An exclusive, non-blocking lock; the open file holds it. None if taken."""
    handle = open(path, "a")  # noqa: SIM115 - held for the life of the process
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return None
    return handle


def _loop(app: Flask, stop: threading.Event) -> None:
    global _lock_file
    failed: dict[int, datetime] = {}
    while not stop.is_set():
        if _lock_file is None:
            _lock_file = try_lock()
            if _lock_file is not None:
                log.info("auto-sync: this worker (pid %s) syncs channels", os.getpid())
        if _lock_file is not None:
            try:
                run_due(app, failed=failed)
            except Exception:  # keep the thread alive whatever one pass does
                log.exception("auto-sync pass failed")
        stop.wait(TICK_SECONDS)


def start(app: Flask) -> threading.Thread | None:
    """Start the background thread once per process, if an interval is set."""
    global _started
    if _started or interval(app) is None:
        return None
    _started = True
    thread = threading.Thread(
        target=_loop, args=(app, threading.Event()), name="channel-autosync", daemon=True
    )
    thread.start()
    return thread
