"""Page routes: channel dashboard, player, signing tool, activity, health."""

from __future__ import annotations

import json
from itertools import groupby

from flask import abort, flash, jsonify, redirect, render_template, request, url_for
from flask_login import login_required

from app.engines import ENGINES
from app.main import bp
from app.models import AdminEvent, Channel, PlaybackEvent, PlaybackSession, UplynkAccount, db
from app.sessions import expires_at
from app.uplynk.playback import CONTENT_TYPES
from app.vite import COMPARE_ENTRY, RECORDING_ENTRY, vite_assets


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
    # embed=1: a pane of /compare (no site header, compatibility panel or Copy link).
    embed = request.args.get("embed") == "1"
    config = {
        "channels": _channel_options(),
        "embed": embed,
        "initialChannel": request.args.get("channel", type=int),
        "initialSrc": request.args.get("src") or None,
        "endpoints": {
            "playback": url_for("api.playback"),
            "sessions": url_for("api.save_session"),
            "versions": {
                package: url_for("api.engine_versions", package=package) for package in ENGINES
            },
        },
    }
    return render_template("main/player.html", config=config, assets=vite_assets(), embed=embed)


@bp.route("/compare")
@login_required
def compare() -> str:
    """Two players side by side; `a` and `b` are player deep-link queries."""
    config = {"channels": _channel_options(), "player": url_for("main.player")}
    return render_template("main/compare.html", config=config, assets=vite_assets(COMPARE_ENTRY))


def _channel_options() -> list[dict]:
    channels = (
        db.session.query(Channel)
        .filter_by(is_active=True)
        .join(UplynkAccount)
        .order_by(UplynkAccount.label, Channel.is_favorite.desc(), Channel.description)
        .all()
    )
    return [
        {
            "id": c.id,
            "name": c.display_name,
            "account": c.uplynk_account.label,
            "channelId": c.channel_id,
            "favorite": c.is_favorite,
            "encryption": c.encryption,
        }
        for c in channels
    ]


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


@bp.route("/sessions")
@login_required
def sessions() -> str:
    rows = (
        db.session.query(PlaybackSession)
        .order_by(PlaybackSession.created_at.desc())
        .limit(500)
        .all()
    )
    return render_template("main/sessions.html", sessions=rows, expires_at=expires_at)


@bp.route("/sessions/<slug>")
@login_required
def session_detail(slug: str) -> str:
    row = db.session.query(PlaybackSession).filter_by(slug=slug).first() or abort(404)
    recording = json.loads(row.data)
    link = str((recording.get("source") or {}).get("link") or "").lstrip("?")
    return render_template(
        "main/session.html",
        session=row,
        recording=recording,
        player_link=f"{url_for('main.player')}?{link}" if link else None,
        expires=expires_at(row),
        assets=vite_assets(RECORDING_ENTRY),
    )


@bp.route("/sessions/<slug>/delete", methods=["POST"])
@login_required
def delete_session(slug: str):
    row = db.session.query(PlaybackSession).filter_by(slug=slug).first() or abort(404)
    db.session.delete(row)
    db.session.commit()
    flash(f"Deleted the recording of {row.title}.", "success")
    return redirect(url_for("main.sessions"))


@bp.route("/health")
def health():
    return jsonify(status="ok")
