"""Saved engine presets: validation and storage.

A preset is the player's deep-link query without a pasted source or rays:
an optional synced channel, format, engine@version, DRM, delay, SSAI ad
server, Uplynk params, CMCD. The browser
builds it (`frontend/src/lib/deeplink.ts`); this re-checks every key with
the same rules, because the engine version ends up in a jsDelivr URL.
"""

from __future__ import annotations

import contextlib
import re
from typing import Any
from urllib.parse import parse_qsl, unquote_plus, urlencode

from app.models import Channel, EnginePreset, User, db
from app.uplynk.params import ParamError, check_params, is_param_key

NAME_MAX = 60
ENGINES = {"hlsjs", "shaka", "dashjs", "native"}
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(-[\w.]+)?$")
# Same order as the player's viewQuery(); the Uplynk params follow ad.
_ORDER = ("channel", "format", "engine", "drm", "delay", "ad", "cmcd")
AD_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")


class PresetError(ValueError):
    """Not a preset we can keep."""


def normalize_query(query: str) -> str:
    """The preset's query with only known keys and valid values, in order."""
    if not isinstance(query, str) or len(query) > 1000:
        raise PresetError("query must be a short string")
    params: dict[str, str] = {}
    uplynk: list[tuple[str, str]] = []
    for key, value in parse_qsl(query.lstrip("?"), keep_blank_values=True):
        if key in ("src", "rays", "tab"):
            continue  # a pasted source and per-load choices aren't part of a preset
        if key == "channel":
            # Optional: a synced channel (our id), chosen when the preset is.
            if not re.fullmatch(r"[1-9]\d{0,9}", value) or not db.session.get(Channel, int(value)):
                raise PresetError(f"unknown channel {value!r}")
            params[key] = value
        elif key == "format":
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
        elif is_param_key(key):
            uplynk.append((key, value))
        elif key == "adp":
            # v3.22.0 packed ad.* params into one; read those too.
            uplynk += parse_qsl(value, keep_blank_values=True)
        elif key == "cmcd":
            if value == "1":
                params[key] = value
        else:
            raise PresetError(f"unknown setting {key!r}")
    if "engine" not in params:
        raise PresetError("a preset needs an engine")
    uplynk = _checked(uplynk, "ad" in params)
    pairs: list[tuple[str, str]] = []
    for key in _ORDER:
        if key in params:
            pairs.append((key, params[key]))
        if key == "ad":
            pairs += uplynk
    return urlencode(pairs, safe="@:/")


def _checked(pairs: list[tuple[str, str]], has_ad: bool) -> list[tuple[str, str]]:
    try:
        return check_params(pairs, has_ad)
    except ParamError as e:
        raise PresetError(str(e)) from None


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


def update_preset(row: EnginePreset, name: Any, query: Any) -> EnginePreset:
    """Rename and/or change a preset in place (the Presets page's Edit)."""
    name = clean_name(name)
    query = normalize_query(query)
    clash = db.session.query(EnginePreset).filter_by(name=name).first()
    if clash is not None and clash.id != row.id:
        raise PresetError(f"another preset is already called {name!r}")
    row.name, row.query = name, query
    db.session.commit()
    return row


ENGINE_LABELS = {"hlsjs": "hls.js", "shaka": "Shaka", "dashjs": "dash.js", "native": "Native"}
DRM_LABELS = {"wv": "Widevine", "pr": "PlayReady", "fps": "FairPlay"}
# The player's Delay menu (frontend/src/lib/clock.ts DELAY_CHOICES).
DELAY_CHOICES = (15, 20, 30, 45, 60, 90, 120)


def parse_params(text: Any) -> list[tuple[str, str]]:
    """`expand=ad_01&ad.lib=KOR` as typed (uplynkParams.ts parseParams), not yet checked."""
    text = text.strip().lstrip("?&") if isinstance(text, str) else ""
    pairs = []
    for part in filter(None, (p.strip() for p in text.split("&"))):
        key, eq, value = part.partition("=")
        if not eq:
            raise PresetError(f"{part} needs a value (ifo=1)")
        pairs.append((key.strip(), unquote_plus(value).strip()))
    return pairs


def query_from_form(form: Any) -> str:
    """A preset query from the Presets page's fields; validated like the API's."""

    def field(name: str) -> str:
        return (form.get(name) or "").strip()

    engine, version = field("engine"), field("version")
    pairs = [("channel", field("channel"))] if field("channel") else []
    pairs.append(("format", field("format") or "hls"))
    pairs.append(("engine", f"{engine}@{version}" if version else engine))
    for key in ("drm", "delay", "ad"):
        if field(key):
            pairs.append((key, field(key)))
    # Checked on their own first, so a typed delay= or rays= isn't read as a setting.
    pairs += _checked(parse_params(field("params")), bool(field("ad")))
    if form.get("cmcd"):
        pairs.append(("cmcd", "1"))
    return normalize_query(urlencode(pairs))


def describe(query: str) -> dict[str, Any]:
    """A preset's settings for people: labels, plus the form's field values."""
    params = parse_qsl(query, keep_blank_values=True)
    get = dict(params).get
    engine, _, version = (get("engine") or "").partition("@")
    uplynk = [(k, v) for k, v in params if is_param_key(k)]
    channel = db.session.get(Channel, int(get("channel"))) if get("channel") else None
    parts = [
        *([f"▶ {channel_label(channel)}"] if channel else []),
        "DASH" if get("format") == "dash" else "HLS",
        f"{ENGINE_LABELS.get(engine, engine)} {version or '(default version)'}",
    ]
    if get("drm"):
        parts.append(DRM_LABELS.get(get("drm"), get("drm")))
    if get("delay"):
        parts.append(f"delay {get('delay')} s")
    signed = ([f"ad={get('ad')}"] if get("ad") else []) + [f"{k}={v}" for k, v in uplynk]
    if signed:
        parts.append(" ".join(signed))
    if get("cmcd"):
        parts.append("CMCD")
    return {
        "parts": parts,
        "fields": {
            "channel": get("channel") or "",
            "format": get("format") or "hls",
            "engine": engine,
            "version": version,
            "drm": get("drm") or "",
            "delay": get("delay") or "",
            "ad": get("ad") or "",
            "params": "&".join(f"{k}={v}" for k, v in uplynk),
            "cmcd": bool(get("cmcd")),
        },
    }


def channel_label(channel: Channel) -> str:
    label = channel.description or channel.channel_id
    return label if channel.is_active else f"{label} (inactive)"


def list_presets() -> list[dict[str, object]]:
    rows = db.session.query(EnginePreset).order_by(EnginePreset.name).all()
    out = []
    for row in rows:
        item = row.as_dict()
        with contextlib.suppress(PresetError):  # an older release's form, today's way
            item["query"] = normalize_query(row.query)
        out.append(item)
    return out
