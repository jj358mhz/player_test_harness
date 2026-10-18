"""SQLAlchemy models.

Everything workspace-specific (API keys, channel IDs, descriptions) lives
here, never in the repo — the repo is public.
"""

from __future__ import annotations

from datetime import UTC, datetime

from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


db = SQLAlchemy(model_class=Base)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )

    # Flask-Login interface
    @property
    def is_authenticated(self) -> bool:
        return True

    @property
    def is_anonymous(self) -> bool:
        return False

    def get_id(self) -> str:
        return str(self.id)

    def __repr__(self) -> str:
        return f"<User {self.email}>"


class UplynkAccount(Base):
    __tablename__ = "uplynk_accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    label: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    # Owner / user ID. Used as `oid` in external-ID playback tokens and as
    # `_owner` in classic API auth.
    workspace_id: Mapped[str] = mapped_column(String(100), nullable=False)

    # Legacy API key: signs playback tokens (HMAC-SHA256) and classic API calls.
    api_key_encrypted: Mapped[str] = mapped_column(Text, nullable=False)

    # Scoped API Key (XAuth/JWT) — optional; preferred for v4 channel listing
    # when present. All four fields come from the .env file downloaded from
    # the Uplynk CMS.
    scoped_kid: Mapped[str | None] = mapped_column(String(100), nullable=True)
    scoped_sub: Mapped[str | None] = mapped_column(String(100), nullable=True)
    scoped_private_b64_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    scoped_scp: Mapped[str | None] = mapped_column(Text, nullable=True)

    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_sync_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )

    channels: Mapped[list[Channel]] = relationship(
        back_populates="uplynk_account", cascade="all, delete-orphan"
    )

    @property
    def has_scoped_key(self) -> bool:
        """True if all four scoped-key fields are populated."""
        return all(
            [
                self.scoped_kid,
                self.scoped_sub,
                self.scoped_private_b64_encrypted,
                self.scoped_scp,
            ]
        )

    def __repr__(self) -> str:
        return f"<UplynkAccount {self.label}>"


class Channel(Base):
    """A live channel as returned by GET /api/v4/channels."""

    __tablename__ = "channels"

    id: Mapped[int] = mapped_column(primary_key=True)
    uplynk_account_id: Mapped[int] = mapped_column(
        ForeignKey("uplynk_accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # System-defined channel GUID.
    channel_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    slicer_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    thumb_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Uplynk's use_chsched: 1 = schedule disabled, 2 = enabled.
    use_chsched: Mapped[int | None] = mapped_column(Integer, nullable=True)
    upstream_created_at: Mapped[str | None] = mapped_column(String(40), nullable=True)

    # What a signed HLS media playlist showed last time we looked:
    # 'drm' (Studio DRM: FairPlay keys), 'aes-128', 'sample-aes', 'none'.
    # NULL until the first Play / Check. See app/uplynk/playback.py.
    encryption: Mapped[str | None] = mapped_column(String(20), nullable=True)
    encryption_checked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_favorite: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )

    __table_args__ = (
        UniqueConstraint("uplynk_account_id", "channel_id", name="uq_account_channel"),
    )

    uplynk_account: Mapped[UplynkAccount] = relationship(back_populates="channels")

    @property
    def display_name(self) -> str:
        return self.description or self.external_id or self.channel_id

    @property
    def is_drm(self) -> bool:
        return self.encryption == "drm"

    def __repr__(self) -> str:
        return f"<Channel {self.channel_id}>"


class PlaybackEvent(Base):
    """Record of every playback URL signed or Preplay request made.

    Stores the unsigned base URL and parameters — never the signature.
    """

    __tablename__ = "playback_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    uplynk_account_id: Mapped[int | None] = mapped_column(
        ForeignKey("uplynk_accounts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    channel_id: Mapped[int | None] = mapped_column(
        ForeignKey("channels.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # 'url' (signed manifest URL) | 'preplay' (Preplay v2 session)
    mode: Mapped[str] = mapped_column(String(20), nullable=False)
    content_type: Mapped[str] = mapped_column(String(2), nullable=False)
    content_id: Mapped[str] = mapped_column(String(255), nullable=False)
    manifest: Mapped[str] = mapped_column(String(10), nullable=False)
    drm: Mapped[str | None] = mapped_column(String(10), nullable=True)
    base_url: Mapped[str] = mapped_column(String(500), nullable=False)
    params: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False, index=True
    )

    user: Mapped[User | None] = relationship()
    uplynk_account: Mapped[UplynkAccount | None] = relationship()
    channel: Mapped[Channel | None] = relationship()


class AdminEvent(Base):
    """Record of administrative actions — account CRUD, sync, auth."""

    __tablename__ = "admin_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    actor_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    category: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(50), nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    target: Mapped[str | None] = mapped_column(String(255), nullable=True)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False, index=True
    )

    actor: Mapped[User | None] = relationship()

    def __repr__(self) -> str:
        return f"<AdminEvent {self.category}.{self.action} by {self.actor_id}>"
