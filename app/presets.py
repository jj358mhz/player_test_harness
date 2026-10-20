"""Saved engine presets: validation and storage.

A preset is the player's deep-link query minus the source (format,
engine@version, DRM, delay, SSAI ad server, CMCD). The browser
builds it (`frontend/src/lib/deeplink.ts`); this re-checks every key with
the same rules, because the engine version ends up in a jsDelivr URL.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qsl, urlencode

from app.models import EnginePreset, User, db

NAME_MAX = 60
ENGINES = {"hlsjs", "shaka", "dashjs", "native"}
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(-[\w.]+)?$")
# Same order as the player's viewQuery().
_ORDER = ("format", "engine", "drm", "delay", "ad", "cmcd")
AD_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")


class PresetError(ValueError):
    """Not a preset we can keep."""


def normalize_query(query: str) -> str:
    """The preset's query with only known keys and valid values, in order."""
    if not isinstance(query, str) or len(query) > 300:
        raise PresetError("query must be a short string")
    params: dict[str, str] = {}
    for key, value in parse_qsl(query.lstrip("?"), keep_blank_values=True):
        if key in ("channel", "src", "rays", "tab"):
            continue  # the source and per-channel choices aren't part of a preset
        if key == "format":
            if value not in ("hls", "dash"):
                raise PresetError(f"unknown format {value!r}")
            if value == "dash":
                params[key] = value
        elif key == "engine":
            name, _, version = value.partition("@")
            if name not in ENGINES:
                raise PresetError(f"unknown engine {name!r}")
            if version and (name == "native" or not VERSION_RE.match(version)):
                raise PresetError(f"bad engine version {version!r}")
            params[key] = value
        elif key == "drm":
            if value not in ("wv", "pr", "fps"):
                raise PresetError(f"unknown DRM {value!r}")
            params[key] = value
        elif key == "delay":
            if not re.fullmatch(r"\d{1,3}", value) or int(value) > 600:
                raise PresetError(f"bad delay {value!r}")
            params[key] = str(int(value))
        elif key == "ad":
            # An SSAI ad configuration name; applied only where the channel's account has it.
            if not AD_NAME_RE.match(value):
                raise PresetError(f"bad ad server name {value!r}")
            params[key] = value
        elif key == "cmcd":
            if value == "1":
                params[key] = value
        else:
            raise PresetError(f"unknown setting {key!r}")
    if "engine" not in params:
        raise PresetError("a preset needs an engine")
    return urlencode([(k, params[k]) for k in _ORDER if k in params], safe="@")


def clean_name(name: Any) -> str:
    if not isinstance(name, str) or not name.strip():
        raise PresetError("name is required")
    name = " ".join(name.split())
    if len(name) > NAME_MAX:
        raise PresetError(f"name must be at most {NAME_MAX} characters")
    return name


def save_preset(data: Any, user: User | None) -> tuple[EnginePreset, bool]:
    """Create a preset, or replace the one with the same name. Returns (row, created)."""
    if not isinstance(data, dict):
        raise PresetError("Expected a JSON object")
    name = clean_name(data.get("name"))
    query = normalize_query(data.get("query"))
    row = db.session.query(EnginePreset).filter_by(name=name).first()
    created = row is None
    if row is None:
        row = EnginePreset(name=name, query=query, user_id=user.id if user else None)
        db.session.add(row)
    else:
        row.query = query
    db.session.commit()
    return row, created


def list_presets() -> list[dict[str, object]]:
    rows = db.session.query(EnginePreset).order_by(EnginePreset.name).all()
    return [r.as_dict() for r in rows]
