"""Ad servers (SSAI ad configuration names) entered per Uplynk account.

The playback param `ad=<name>` picks the ad configuration whose ad decision
server fills the breaks; without it there are no ads, and a name that
doesn't exist stops playback. Channel sync lists them from Uplynk's
undocumented `/api/v4/ads/servers` (`sync_ad_servers`); names can also be
added by hand. Only the list is filled: nothing chooses an ad server for a
channel.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qsl, urlencode

from app.models import AdServer, UplynkAccount, db
from app.uplynk.channels import DiscoveredAdServer

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


@dataclass
class AdSyncResult:
    added: int = 0
    unlisted: int = 0
    skipped: int = 0  # names we couldn't sign as ad=


def sync_ad_servers(account: UplynkAccount, discovered: list[DiscoveredAdServer]) -> AdSyncResult:
    """Match the account's rows to what the API lists; the caller commits.

    New names are added; known ones get the API's type and provider and keep
    their description and params; rows it no longer lists are kept, unlisted.
    """
    result = AdSyncResult()
    now = datetime.now(UTC)
    rows = {row.name: row for row in account.ad_servers}
    seen: set[str] = set()
    for server in discovered:
        if not NAME_RE.match(server.name):
            result.skipped += 1
            continue
        seen.add(server.name)
        row = rows.get(server.name)
        if row is None:
            row = AdServer(uplynk_account_id=account.id, name=server.name)
            account.ad_servers.append(row)
            result.added += 1
        row.ad_type = (server.type or "")[:100] or None
        row.provider = (server.provider or "")[:100] or None
        row.last_seen_at = now
        row.is_listed = True
    for name, row in rows.items():
        if name not in seen and row.is_listed:
            row.is_listed = False
            result.unlisted += 1
    return result
