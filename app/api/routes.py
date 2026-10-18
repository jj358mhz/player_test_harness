"""JSON API routes. Session-authenticated; CSRF token via X-CSRFToken header."""

from __future__ import annotations

from flask import Blueprint, jsonify, request
from flask_login import login_required

from app.api.service import create_playback, parse_request
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
            }
            for c in rows
        ]
    )
