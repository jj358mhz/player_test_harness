"""Gunicorn config for player-test-harness."""

import multiprocessing
import os

bind = "0.0.0.0:5000"
workers = int(os.getenv("GUNICORN_WORKERS", multiprocessing.cpu_count() * 2 + 1))
worker_class = "sync"
timeout = 30
graceful_timeout = 30
keepalive = 5

# gunicorn 26+ opens a control socket in the working dir, which the app
# user can't write to. We don't use gunicornc, so turn it off.
control_socket_disable = True


def post_worker_init(worker):
    """Background channel sync (app/autosync.py); one worker runs it, by file lock."""
    from app.autosync import start

    start(worker.wsgi)


accesslog = "-"
errorlog = "-"
loglevel = os.getenv("LOG_LEVEL", "info")

# Only forwarded proto/for from local/private ranges (behind Traefik/nginx)
forwarded_allow_ips = "*"
