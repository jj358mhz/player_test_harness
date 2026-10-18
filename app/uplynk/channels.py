"""Client for the Uplynk v4 live channels API.

GET /api/v4/channels — https://docs.uplynk.com/reference/get-all-live-channels
Uses the scoped key (JWT) when one is configured, otherwise classic auth.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import requests

from app.uplynk.auth import UplynkAuthError, build_jwt, classic_auth_params

CHANNELS_READ_SCOPE = "video.services.channels:read"


class UplynkAPIError(RuntimeError):
    """Raised when the Uplynk API returns an error or invalid response."""


@dataclass(frozen=True)
class DiscoveredChannel:
    channel_id: str
    external_id: str | None
    description: str | None
    slicer_id: str | None
    thumb_url: str | None
    use_chsched: int | None
    created: str | None

    @classmethod
    def from_api(cls, item: dict[str, Any]) -> DiscoveredChannel:
        return cls(
            channel_id=item["id"],
            external_id=item.get("external_id") or None,
            description=item.get("desc") or None,
            slicer_id=item.get("slicer_id") or None,
            thumb_url=item.get("thumb_url") or None,
            use_chsched=item.get("use_chsched"),
            created=item.get("created"),
        )


@dataclass(frozen=True)
class ScopedCredentials:
    kid: str
    sub: str
    private_b64: str
    scp: str


class UplynkChannelsClient:
    LIST_ENDPOINT = "/api/v4/channels"

    def __init__(
        self,
        api_base: str,
        owner_id: str,
        api_key: str | None = None,
        scoped: ScopedCredentials | None = None,
        timeout: int = 15,
        session: requests.Session | None = None,
    ) -> None:
        if not scoped and not api_key:
            raise UplynkAPIError("Need a scoped key or an API key to list channels")
        self.api_base = api_base.rstrip("/")
        self.owner_id = owner_id
        self.api_key = api_key
        self.scoped = scoped
        self.timeout = timeout
        self._session = session or requests.Session()

    @property
    def auth_mode(self) -> str:
        return "scoped" if self.scoped else "classic"

    def _auth(self) -> tuple[dict[str, str], dict[str, str]]:
        """Return (headers, params) for one request."""
        headers = {"Accept": "application/json"}
        try:
            if self.scoped:
                headers["X-Auth-Uplynk-Jwt"] = build_jwt(
                    self.scoped.kid, self.scoped.sub, self.scoped.private_b64, self.scoped.scp
                )
                return headers, {}
            return headers, classic_auth_params(self.owner_id, self.api_key)
        except UplynkAuthError as e:
            raise UplynkAPIError(str(e)) from e

    # The API returns at most 40 items per page whatever page_size says;
    # `page` (1-based) walks the rest. `total_items` tells us when to stop.
    MAX_PAGES = 250

    def list_channels(self) -> list[DiscoveredChannel]:
        channels: dict[str, DiscoveredChannel] = {}
        total: int | None = None
        for page in range(1, self.MAX_PAGES + 1):
            payload = self._get_page(page)
            items = payload["items"]
            try:
                for item in items:
                    channel = DiscoveredChannel.from_api(item)
                    channels.setdefault(channel.channel_id, channel)
            except KeyError as e:
                raise UplynkAPIError(f"Uplynk API item missing required field: {e}") from e
            if isinstance(payload.get("total_items"), int):
                total = payload["total_items"]
            if not items or (total is not None and len(channels) >= total):
                break
        else:
            raise UplynkAPIError(f"Stopped after {self.MAX_PAGES} pages of channels")
        if total is not None and len(channels) < total:
            # A page went missing (e.g. channels moved between requests). Fail the
            # sync rather than deactivate channels we simply didn't see.
            raise UplynkAPIError(
                f"Uplynk reported {total} channels but only {len(channels)} came back; try again"
            )
        return list(channels.values())

    def _get_page(self, page: int) -> dict:
        headers, params = self._auth()
        params = {**params, "page": page}
        url = f"{self.api_base}{self.LIST_ENDPOINT}"
        try:
            response = self._session.get(url, headers=headers, params=params, timeout=self.timeout)
        except requests.RequestException as e:
            raise UplynkAPIError(f"Request to Uplynk failed: {e}") from e

        if response.status_code == 401:
            hint = "KID/SUB/PRIVATE_B64" if self.scoped else "workspace ID / API key"
            raise UplynkAPIError(f"Uplynk API rejected the credentials (401) — check {hint}")
        if response.status_code == 403:
            raise UplynkAPIError(f"Credentials lack the required scope ({CHANNELS_READ_SCOPE})")
        if response.status_code != 200:
            raise UplynkAPIError(
                f"Uplynk API returned HTTP {response.status_code}: {response.text[:200]}"
            )

        try:
            payload = response.json()
        except ValueError as e:
            raise UplynkAPIError("Uplynk API returned non-JSON response") from e

        if payload.get("error"):
            raise UplynkAPIError(f"Uplynk API error: {payload.get('msg') or payload['error']}")
        if not isinstance(payload.get("items"), list):
            raise UplynkAPIError("Uplynk API response missing 'items' list")
        return payload
