"""Page routes: channel dashboard, player, signing tool, activity, health."""

from __future__ import annotations

from itertools import groupby
from pathlib import Path

from flask import abort, jsonify, redirect, render_template, request, send_file, url_for
from flask_login import login_required

from app.main import bp
from app.models import AdminEvent, Channel, PlaybackEvent, UplynkAccount, db
from app.uplynk.playback import CONTENT_TYPES
from app.vite import vite_assets

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
    """Open the player on a channel; the player signs and checks the URL itself."""
    if db.session.get(Channel, channel_id) is None:
        abort(404)
    return redirect(url_for("main.player", channel=channel_id))


@bp.route("/player")
@login_required
def player() -> str:
    channels = (
        db.session.query(Channel)
        .filter_by(is_active=True)
        .join(UplynkAccount)
        .order_by(UplynkAccount.label, Channel.is_favorite.desc(), Channel.description)
        .all()
    )
    config = {
        "channels": [
            {
                "id": c.id,
                "name": c.display_name,
                "account": c.uplynk_account.label,
                "channelId": c.channel_id,
                "favorite": c.is_favorite,
            }
            for c in channels
        ],
        "initialChannel": request.args.get("channel", type=int),
        "initialSrc": request.args.get("src") or None,
        "endpoints": {
            "playback": url_for("api.playback"),
            "versions": url_for("api.engine_versions", package="hls.js"),
            "classic": url_for("main.player_classic"),
        },
    }
    return render_template("main/player.html", config=config, assets=vite_assets())


@bp.route("/player/classic")
@login_required
def player_classic():
    """The original single-file player, kept until the new one reaches parity."""
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
