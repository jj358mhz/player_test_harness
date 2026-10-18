"""Page routes: channel dashboard, player, signing tool, activity, health."""

from __future__ import annotations

from itertools import groupby
from pathlib import Path

from flask import abort, flash, jsonify, redirect, render_template, request, send_file, url_for
from flask_login import login_required

from app.api.service import create_playback, parse_request
from app.main import bp
from app.models import AdminEvent, Channel, PlaybackEvent, UplynkAccount, db
from app.uplynk.playback import CONTENT_TYPES, PlaybackError

PLAYER_HTML = Path(__file__).resolve().parent.parent / "player" / "hls-id3-player.html"


@bp.route("/")
@login_required
def index() -> str:
    channels = (
        db.session.query(Channel)
        .filter_by(is_active=True)
        .join(UplynkAccount)
        .order_by(UplynkAccount.label, Channel.is_favorite.desc(), Channel.description)
        .all()
    )
    groups = [
        (label, list(items))
        for label, items in groupby(channels, key=lambda c: c.uplynk_account.label)
    ]
    account_count = db.session.query(UplynkAccount).count()
    return render_template(
        "main/index.html", groups=groups, total=len(channels), account_count=account_count
    )


@bp.route("/channels/<int:channel_id>/favorite", methods=["POST"])
@login_required
def toggle_favorite(channel_id: int):
    channel = db.session.get(Channel, channel_id) or abort(404)
    channel.is_favorite = not channel.is_favorite
    db.session.commit()
    return redirect(url_for("main.index") + f"#channel-{channel.id}")


@bp.route("/channels/<int:channel_id>/play")
@login_required
def play_channel(channel_id: int):
    """Sign an HLS URL for the channel and open it in the player."""
    if db.session.get(Channel, channel_id) is None:
        abort(404)
    try:
        result = create_playback(parse_request({"channel_id": channel_id, "manifest": "m3u8"}))
    except PlaybackError as e:
        flash(f"Could not sign playback URL: {e}", "error")
        return redirect(url_for("main.index"))
    return redirect(url_for("main.player", src=result["url"]))


@bp.route("/player")
@login_required
def player():
    return send_file(PLAYER_HTML, mimetype="text/html", max_age=0)


@bp.route("/sign")
@login_required
def sign_tool() -> str:
    accounts = db.session.query(UplynkAccount).order_by(UplynkAccount.label).all()
    channel = None
    if request.args.get("channel"):
        channel = db.session.get(Channel, request.args.get("channel", type=int))
    return render_template(
        "main/sign.html",
        accounts=accounts,
        channel=channel,
        content_types=CONTENT_TYPES,
    )


@bp.route("/activity")
@login_required
def activity() -> str:
    playback_events = (
        db.session.query(PlaybackEvent).order_by(PlaybackEvent.timestamp.desc()).limit(200).all()
    )
    admin_events = (
        db.session.query(AdminEvent).order_by(AdminEvent.timestamp.desc()).limit(200).all()
    )
    return render_template(
        "main/activity.html", playback_events=playback_events, admin_events=admin_events
    )


@bp.route("/health")
def health():
    return jsonify(status="ok")
