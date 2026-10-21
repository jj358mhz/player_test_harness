"""Sync live channels from the Uplynk v4 API into our database."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from flask import current_app

from app.ads import AdSyncResult, sync_ad_servers
from app.crypto import decrypt
from app.models import Channel, UplynkAccount, db
from app.uplynk.channels import (
    DiscoveredChannel,
    ScopedCredentials,
    UplynkAPIError,
    UplynkChannelsClient,
)


@dataclass
class SyncResult:
    """Summary of a single sync run."""

    account_id: int
    account_label: str
    auth_mode: str | None = None
    created: int = 0
    updated: int = 0
    deactivated: int = 0
    error: str | None = None
    ad_servers: AdSyncResult | None = None
    ad_error: str | None = None

    @property
    def summary(self) -> str:
        if self.error:
            return f"Sync failed for '{self.account_label}': {self.error}"
        text = (
            f"Synced '{self.account_label}' ({self.auth_mode} auth): "
            f"{self.created} new, {self.updated} updated, {self.deactivated} deactivated"
        )
        if self.ad_error:
            return f"{text}; ad servers not synced: {self.ad_error}"
        ads = self.ad_servers
        if ads and (ads.added or ads.unlisted or ads.skipped):
            parts = [f"{ads.added} new"] if ads.added else []
            if ads.unlisted:
                parts.append(f"{ads.unlisted} no longer listed")
            if ads.skipped:
                parts.append(f"{ads.skipped} skipped (name not usable as ad=)")
            text += f"; ad servers: {', '.join(parts)}"
        return text


def build_client(account: UplynkAccount) -> UplynkChannelsClient:
    """Build a channels client, preferring the scoped key when configured."""
    scoped = None
    if account.has_scoped_key:
        scoped = ScopedCredentials(
            kid=account.scoped_kid,
            sub=account.scoped_sub,
            private_b64=decrypt(account.scoped_private_b64_encrypted),
            scp=account.scoped_scp,
        )
    return UplynkChannelsClient(
        api_base=current_app.config["UPLYNK_API_BASE"],
        owner_id=account.workspace_id,
        api_key=decrypt(account.api_key_encrypted),
        scoped=scoped,
    )


def sync_account(account: UplynkAccount) -> SyncResult:
    """Sync one account's channels into the DB.

    - New channel IDs are created.
    - Existing channels have their metadata refreshed (favorites are kept).
    - Channels missing from this response are marked inactive.
    - The account's ad servers are listed too (`app.ads.sync_ad_servers`).
    """
    result = SyncResult(account_id=account.id, account_label=account.label)

    try:
        client = build_client(account)
        result.auth_mode = client.auth_mode
        discovered = client.list_channels()
    except UplynkAPIError as e:
        result.error = str(e)
    except Exception as e:  # decrypt failures etc.
        result.error = f"{type(e).__name__}: {e}"

    if result.error:
        account.last_sync_error = result.error
        db.session.commit()
        return result

    _apply_sync(account, discovered, result)
    # Ad servers ride along; their failure doesn't fail the channel sync.
    try:
        result.ad_servers = sync_ad_servers(account, client.list_ad_servers())
    except UplynkAPIError as e:
        result.ad_error = str(e)
        current_app.logger.warning("Ad server sync failed for %s: %s", account.label, e)
    account.last_synced_at = datetime.now(UTC)
    account.last_sync_error = None
    db.session.commit()
    return result


def _apply_sync(
    account: UplynkAccount,
    discovered: list[DiscoveredChannel],
    result: SyncResult,
) -> None:
    now = datetime.now(UTC)
    existing = {
        c.channel_id: c
        for c in db.session.query(Channel).filter_by(uplynk_account_id=account.id).all()
    }
    seen: set[str] = set()

    for dc in discovered:
        seen.add(dc.channel_id)
        channel = existing.get(dc.channel_id)
        if channel is None:
            channel = Channel(uplynk_account_id=account.id, channel_id=dc.channel_id)
            db.session.add(channel)
            result.created += 1
        else:
            result.updated += 1
        channel.external_id = dc.external_id
        channel.description = dc.description
        channel.slicer_id = dc.slicer_id
        channel.thumb_url = dc.thumb_url
        channel.use_chsched = dc.use_chsched
        channel.upstream_created_at = dc.created
        channel.is_active = True
        channel.last_seen_at = now

    for channel_id, channel in existing.items():
        if channel_id not in seen and channel.is_active:
            channel.is_active = False
            result.deactivated += 1
