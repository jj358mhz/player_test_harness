"""Client for the Uplynk Live Events API (v2).

GET /api2/liveevents2/list — https://docs.uplynk.com/reference/get-list-of-live-events
Classic auth only, the v2 way: the call's params travel inside the signed
`msg` body with `_owner`/`_timestamp`, not as query params. Paged with
`limit` (max 100) and `skip`; no total count, so a short page ends it.
`start`/`stop` (UTC ms) filter on `expected_start` (`stop` defaults to
start + 8 h). The answer is `{"events": [...], "error": 0}`.

Events play from `content.uplynk.com/event/<id>.{m3u8,mpd}` (token `ct=e`).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import requests

from app.uplynk.auth import UplynkAuthError, classic_auth_params
from app.uplynk.channels import UplynkAPIError

PAGE_LIMIT = 100
MAX_PAGES = 50


def _when(value: Any) -> datetime | None:
    """Uplynk event times: UTC epoch ms (0/None = not yet)."""
    if not isinstance(value, int | float) or isinstance(value, bool) or value <= 0:
        return None
    # Be lenient about seconds: anything before 2001 in ms is really seconds.
    seconds = value / 1000 if value > 1e12 else value
    return datetime.fromtimestamp(seconds, UTC)


@dataclass(frozen=True)
class DiscoveredEvent:
    event_id: str
    external_id: str | None
    description: str | None
    state: str | None
    slicer_id: str | None
    expected_start: datetime | None
    expected_stop: datetime | None
    actual_start: datetime | None
    actual_stop: datetime | None
    require_drm: bool

    @classmethod
    def from_api(cls, item: dict[str, Any]) -> DiscoveredEvent:
        slicers = item.get("slicers") or []
        first = slicers[0] if slicers and isinstance(slicers[0], dict) else {}
        return cls(
            event_id=item["id"],
            external_id=item.get("external_id") or None,
            description=item.get("desc") or None,
            state=str(item["state"]) if item.get("state") else None,
            slicer_id=first.get("id") or None,
            expected_start=_when(item.get("expected_start")),
            expected_stop=_when(item.get("expected_stop")),
            actual_start=_when(item.get("actual_start")),
            actual_stop=_when(item.get("actual_stop")),
            require_drm=bool(item.get("require_drm") or item.get("require_studio_drm")),
        )


class UplynkEventsClient:
    LIST_ENDPOINT = "/api2/liveevents2/list"

    def __init__(
        self,
        api_base: str,
        owner_id: str,
        api_key: str,
        timeout: int = 15,
        session: requests.Session | None = None,
    ) -> None:
        self.api_base = api_base.rstrip("/")
        self.owner_id = owner_id
        self.api_key = api_key
        self.timeout = timeout
        self._session = session or requests.Session()

    def list_events(self, start: datetime, stop: datetime) -> list[DiscoveredEvent]:
        """Events expected to start between `start` and `stop`, deleted ones left out."""
        events: dict[str, DiscoveredEvent] = {}
        window = {
            "start": int(start.timestamp() * 1000),
            "stop": int(stop.timestamp() * 1000),
            "order": "expected_start",
            "limit": PAGE_LIMIT,
        }
        for page in range(MAX_PAGES):
            items = self._get({**window, "skip": page * PAGE_LIMIT})
            try:
                for item in items:
                    if item.get("deleted"):
                        continue
                    event = DiscoveredEvent.from_api(item)
                    events.setdefault(event.event_id, event)
            except (KeyError, TypeError, AttributeError) as e:
                raise UplynkAPIError(f"Uplynk live event item missing an id: {e}") from e
            if len(items) < PAGE_LIMIT:
                break
        else:
            raise UplynkAPIError(f"Stopped after {MAX_PAGES} pages of live events")
        return list(events.values())

    def _get(self, body: dict[str, Any]) -> list[dict[str, Any]]:
        try:
            params = classic_auth_params(self.owner_id, self.api_key, extra=body)
        except UplynkAuthError as e:
            raise UplynkAPIError(str(e)) from e
        url = f"{self.api_base}{self.LIST_ENDPOINT}"
        try:
            response = self._session.get(
                url, params=params, headers={"Accept": "application/json"}, timeout=self.timeout
            )
        except requests.RequestException as e:
            raise UplynkAPIError(f"Request to Uplynk failed: {e}") from e
        if response.status_code in (401, 403):
            raise UplynkAPIError(
                f"Uplynk refused the live events list ({response.status_code}) — "
                "check the workspace ID / API key"
            )
        if response.status_code != 200:
            raise UplynkAPIError(
                f"Uplynk API returned HTTP {response.status_code}: {response.text[:200]}"
            )
        try:
            payload = response.json()
        except ValueError as e:
            raise UplynkAPIError("Uplynk API returned non-JSON response") from e
        if not isinstance(payload, dict):
            raise UplynkAPIError("Uplynk live events answer is not an object")
        if payload.get("error"):
            raise UplynkAPIError(f"Uplynk API error: {payload.get('msg') or payload['error']}")
        if not isinstance(payload.get("events"), list):
            raise UplynkAPIError("Uplynk live events answer has no 'events' list")
        return payload["events"]
