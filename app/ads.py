"""Ad servers (SSAI ad configuration names) entered per Uplynk account.

The playback param `ad=<name>` picks the ad configuration whose ad decision
server fills the breaks; without it there are no ads, and a name that
doesn't exist stops playback. Uplynk has no API that lists them.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import parse_qsl, urlencode

from app.models import AdServer, UplynkAccount, db

NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")


class AdServerError(ValueError):
    """Not an ad server we can keep."""


def clean_name(value: Any) -> str:
    name = (value or "").strip() if isinstance(value, str) else ""
    if not NAME_RE.match(name):
        raise AdServerError(
            "Name must be the ad configuration's name as used in ad=… "
            "(letters, digits, . _ -; up to 100)"
        )
    return name


def clean_params(value: Any) -> str | None:
    """Extra `ad.*` params, as a query string (`ad.breakend=chop&ad.kv=…`)."""
    text = (value or "").strip().lstrip("?&") if isinstance(value, str) else ""
    if not text:
        return None
    pairs = parse_qsl(text, keep_blank_values=True, strict_parsing=False)
    if not pairs:
        raise AdServerError("Params must look like ad.breakend=chop&ad.flex=10")
    for key, _ in pairs:
        if not key.startswith("ad.") or len(key) < 4:
            raise AdServerError(f"Only ad.* params belong here, not {key!r}")
    out = urlencode(pairs)
    if len(out) > 500:
        raise AdServerError("Params are too long (500 characters at most)")
    return out


def add_ad_server(account: UplynkAccount, name: Any, description: Any, params: Any) -> AdServer:
    name = clean_name(name)
    if any(s.name == name for s in account.ad_servers):
        raise AdServerError(f"{name!r} is already listed for {account.label}")
    row = AdServer(
        uplynk_account_id=account.id,
        name=name,
        description=((description or "").strip()[:200] or None)
        if isinstance(description, str)
        else None,
        params=clean_params(params),
    )
    db.session.add(row)
    db.session.commit()
    return row


def by_account() -> dict[str, list[dict[str, object]]]:
    """Every account's ad servers, keyed by account id (as a string, for JSON)."""
    out: dict[str, list[dict[str, object]]] = {}
    for row in db.session.query(AdServer).order_by(AdServer.name).all():
        out.setdefault(str(row.uplynk_account_id), []).append(row.as_dict())
    return out
