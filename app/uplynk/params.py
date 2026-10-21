"""Uplynk customization params a player load may sign in.

The same rules as the player's Params box (`frontend/src/lib/uplynkParams.ts`,
whose + param menu is the list of exact keys); presets re-check them here.
`tests/test_uplynk_params.py` checks the two lists match.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

# Exact keys (the menu's, less the prefixed families).
PARAM_KEYS = frozenset(
    {
        "expand",
        "ddp",
        "ifo",
        "hlsver",
        "maxfps",
        "rates",
        "resolutions",
        "show_vtt",
        "show_dash_subtitles",
        "dash_subtitles_merge",
        "subtitle_placeholders_off",
        "thumbsray",
        "srs",
        "forcecic",
        "smartcic",
        "nielsen",
        "needscors",
        "euid",
        "ptid",
        "opaqueid",
        "up.max_concurrent_sessions",
        "geo.country.allow",
        "geo.country.deny",
        "repl",
        "dmm.schemas.top",
        "dmm.schemas.break",
        "timedmeta.schemas.ads",
        "timedmeta.events.ads",
        "timedmeta.extensions.ads",
        "staticomsdk",
        "drm_policy_name",
        "drm_optional",
        "ck",
        "fpuseki",
    }
)
# Families: ad.<anything>, fp.hd.hdcp, rmp.…, pr.hd.…
PARAM_PREFIXES = ("ad.", "fp.", "rmp.", "pr.")

# Keys a load mustn't type, and where they're set instead.
RESERVED = {
    "ad": "choose the ad server in the Ads menu, not as ad=",
    "rays": "pick rays in the ABR tab, not as rays=",
    "delay": "use the Delay menu, not delay=",
    "pdts": "the player signs pdts=latency itself",
    "cmcd": "use the CMCD checkbox",
    "CMCD": "use the CMCD checkbox",
    "ak": "ak= changes the signing key; the account's API key signs here",
    "manifest": "the player sets manifest= for Preplay",
    "rmt": "the player sets rmt= for Preplay (DRM menu)",
    **{
        k: f"{k}= is part of the token"
        for k in ("tc", "exp", "rn", "ct", "cid", "eid", "oid", "sig", "pbs", "jsonp")
    },
}

KEY_RE = re.compile(r"^[A-Za-z0-9_.]{1,60}$")
# Values stay URL-plain on purpose.
VALUE_RE = re.compile(r"^[A-Za-z0-9_.,:/|\- ]{0,200}$")
EXPAND_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}(,[A-Za-z0-9_-]{1,64}){0,9}$")
MAX_PARAMS = 20


class ParamError(ValueError):
    """A param we won't sign."""


def is_param_key(key: str) -> bool:
    if not KEY_RE.match(key) or key.endswith("."):
        return False
    return key in PARAM_KEYS or key.startswith(PARAM_PREFIXES)


def check_params(pairs: Iterable[tuple[str, str]], has_ad: bool) -> list[tuple[str, str]]:
    """The pairs, checked like parseParams(): known keys, plain values, ad.* with an ad server or expand."""
    out = []
    for key, value in pairs:
        key, value = key.strip(), value.strip()
        if key in RESERVED:
            raise ParamError(RESERVED[key])
        if not is_param_key(key):
            raise ParamError(f"{key} isn't a param this player signs")
        if not VALUE_RE.match(value):
            raise ParamError(f"{key} has characters that aren't allowed")
        if key == "expand" and not EXPAND_RE.match(value):
            raise ParamError("expand= takes set names, comma-separated (expand=ad_01,playback_01)")
        out.append((key, value))
    if len(out) > MAX_PARAMS:
        raise ParamError(f"at most {MAX_PARAMS} params")
    if not has_ad and not any(k == "expand" for k, _ in out):
        ad = next((k for k, _ in out if k.startswith("ad.")), None)
        if ad:
            raise ParamError(f"{ad} needs an ad server or an expand= set that names one")
    return out
