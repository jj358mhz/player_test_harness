"""JSON API routes. Session-authenticated; CSRF token via X-CSRFToken header."""

from __future__ import annotations

from flask import Blueprint, jsonify, request
from flask_login import login_required

from app.api.service import create_playback, parse_request
from app.engines import EngineVersionsError
from app.engines import engine_versions as list_engine_versions
from app.models import Channel, UplynkAccount, db
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
