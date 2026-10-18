"""Uplynk API authentication helpers.

Two schemes, both supported by the v4 channels API:

- Scoped API Key (XAuth): ES256-signed JWT sent in `X-Auth-Uplynk-Jwt`.
  See https://docs.uplynk.com/reference/scoped-api-keys.
- Classic: `msg` (base64 of zlib-compressed JSON with `_owner`/`_timestamp`)
  and `sig` (HMAC-SHA256 of msg with the API key) as query params.
  See https://docs.uplynk.com/recipes/api-auth-for-classic-authentication-v4-apis.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import zlib

import jwt
from cryptography.hazmat.primitives import serialization


class UplynkAuthError(RuntimeError):
    """Raised when credentials can't be turned into a valid auth token."""


def build_jwt(
    kid: str,
    sub: str,
    private_b64: str,
    scp: str,
    ttl_seconds: int = 300,
    now: int | None = None,
) -> str:
    """Build an ES256-signed JWT for Uplynk scoped-key auth."""
    try:
        private_bytes = base64.b64decode(private_b64)
    except (ValueError, TypeError) as e:
        raise UplynkAuthError(f"Invalid PRIVATE_B64 (not valid base64): {e}") from e

    try:
        private_key = serialization.load_pem_private_key(private_bytes, password=None)
    except Exception as e:
        raise UplynkAuthError(f"Could not load private key: {e}") from e

    now = int(time.time()) if now is None else now
    payload = {
        "iat": now,
        "exp": now + ttl_seconds,
        "sub": sub,
        "scp": [s.strip() for s in scp.split(",") if s.strip()],
    }
    headers = {"kid": kid, "typ": "JWT"}
    return jwt.encode(payload, private_key, algorithm="ES256", headers=headers)


def classic_auth_params(
    owner_id: str,
    api_key: str,
    extra: dict | None = None,
    now: int | None = None,
) -> dict[str, str]:
    """Return the `msg` / `sig` query params for a classic-auth API call."""
    if not owner_id or not api_key:
        raise UplynkAuthError("Classic auth needs both a workspace ID and an API key")
    body = dict(extra or {})
    body["_owner"] = owner_id
    body["_timestamp"] = int(time.time()) if now is None else now
    msg = base64.b64encode(zlib.compress(json.dumps(body).encode(), 9)).strip()
    sig = hmac.new(api_key.encode(), msg, hashlib.sha256).hexdigest()
    return {"msg": msg.decode(), "sig": sig}
