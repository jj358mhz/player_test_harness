"""WTForms for admin UI."""

from __future__ import annotations

from flask_wtf import FlaskForm
from flask_wtf.file import FileAllowed, FileField
from wtforms import BooleanField, PasswordField, StringField, SubmitField
from wtforms.validators import DataRequired, Length, Optional


class UplynkAccountForm(FlaskForm):
    """Create or edit an Uplynk account.

    - API Key: paste directly (required on create). Signs playback tokens and,
      without a scoped key, classic-auth channel sync.
    - Scoped API Key: optional .env upload; preferred for channel sync.
    """

    label = StringField(
        "Label",
        validators=[DataRequired(), Length(max=100)],
        description="A name for this workspace, e.g. the workspace username in the Uplynk CMS.",
    )
    workspace_id = StringField(
        "Workspace (Owner) ID",
        validators=[DataRequired(), Length(max=100)],
        description="The workspace's user/owner ID. Used for external-ID playback and classic API auth.",
    )
    api_key = PasswordField(
        "API Key",
        validators=[Optional(), Length(max=500)],
        description="From Settings → Integration Keys. Signs playback tokens. "
        "Leave blank on edit to keep the existing value.",
        render_kw={"autocomplete": "off"},
    )
    scoped_env_file = FileField(
        "Scoped API Key (.env file, optional)",
        validators=[
            Optional(),
            FileAllowed(["env", "txt"], "Upload the .env file from the Uplynk CMS."),
        ],
        description="Download from Settings → Scoped API Keys. Needs the "
        "video.services.channels:read scope. When present it's used for channel "
        "sync instead of the API key. Leave blank on edit to keep the existing value.",
    )
    sync_events = BooleanField(
        "Sync live events",
        description="Also list this workspace's Live Events (pre-event and live; ended "
        "ones drop off) on each sync, so they can be played from the Events page and the player. "
        "Uses the API key (classic auth).",
    )
    submit = SubmitField("Save")
