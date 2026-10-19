"""JSON API routes. Session-authenticated; CSRF token via X-CSRFToken header."""

from __future__ import annotations

from flask import Blueprint, abort, current_app, jsonify, request, url_for
from flask_login import current_user, login_required

from app import csl
from app.api.service import create_playback, parse_request
from app.engines import EngineVersionsError
from app.engines import engine_versions as list_engine_versions
from app.models import Channel, PlaybackSession, UplynkAccount, db
from app.sessions import RecordingError, save_recording
from app.uplynk.playback import PlaybackError

bp = Blueprint("api", __name__, url_prefix="/api")


@bp.route("/playback", methods=["POST"])
@login_required
def playback():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(error="Expected a JSON object body"), 400
    try:
        result = create_playback(parse_request(data))
    except PlaybackError as e:
        return jsonify(error=str(e)), 400
    return jsonify(result)


@bp.route("/channels")
@login_required
def channels():
    rows = (
        db.session.query(Channel)
        .filter_by(is_active=True)
        .join(UplynkAccount)
        .order_by(UplynkAccount.label, Channel.is_favorite.desc(), Channel.description)
        .all()
    )
    return jsonify(
        items=[
            {
                "id": c.id,
                "channel_id": c.channel_id,
                "external_id": c.external_id,
                "name": c.display_name,
                "slicer_id": c.slicer_id,
                "account": c.uplynk_account.label,
                "favorite": c.is_favorite,
                "encryption": c.encryption,
            }
            for c in rows
        ]
    )


@bp.route("/channels/<int:channel_id>/slicer")
@login_required
def channel_slicer(channel_id: int):
    """What csl-slicer-console knows about the channel's slicer (wallclock)."""
    if not csl.enabled():
        abort(404)
    channel = db.session.get(Channel, channel_id) or abort(404)
    if not channel.slicer_id:
        return jsonify(
            slicer_id=None, found=False, wallclock=None, captured_at=None, running=None, error=None
        )
    return jsonify(slicer_id=channel.slicer_id, **csl.slicer_settings(channel.slicer_id))


@bp.route("/engines/<path:package>/versions")
@login_required
def engine_versions(package: str):
    """Version menu for a player engine: latest patch of the last 3 minors."""
    try:
        versions = list_engine_versions(package)
    except EngineVersionsError as e:
        return jsonify(error=str(e), versions=[]), 502
    return jsonify(package=package, versions=versions)


@bp.route("/channels/favorite", methods=["POST"])
@login_required
def favorite_channels():
    """Pin or unpin several channels: {"ids": [1, 2], "favorite": true}."""
    data = request.get_json(silent=True) or {}
    ids = data.get("ids")
    if not isinstance(ids, list) or not all(isinstance(i, int) for i in ids):
        return jsonify(error="ids must be a list of channel ids"), 400
    value = bool(data.get("favorite", True))
    updated = (
        db.session.query(Channel)
        .filter(Channel.id.in_(ids))
        .update({Channel.is_favorite: value}, synchronize_session=False)
    )
    db.session.commit()
    return jsonify(updated=updated, favorite=value)


@bp.route("/sessions", methods=["POST"])
@login_required
def save_session():
    """Store a recorded player session; answers with its replay link."""
    limit = current_app.config["MAX_RECORDING_BYTES"]
    if (request.content_length or 0) > limit:
        return jsonify(error=f"Recording is larger than {limit // 1024} KB"), 413
    try:
        row = save_recording(request.get_json(silent=True), current_user)
    except RecordingError as e:
        return jsonify(error=str(e)), 400
    return (
        jsonify(
            id=row.slug,
            url=url_for("main.session_detail", slug=row.slug),
            size_kb=round(row.size_bytes / 1024),
            retention_days=current_app.config["SESSION_RETENTION_DAYS"],
        ),
        201,
    )


@bp.route("/sessions/<slug>")
@login_required
def session_json(slug: str):
    """The stored (redacted) recording, for download."""
    row = db.session.query(PlaybackSession).filter_by(slug=slug).first() or abort(404)
    response = current_app.response_class(row.data, mimetype="application/json")
    response.headers["Content-Disposition"] = f'attachment; filename="session-{row.slug}.json"'
    return response
