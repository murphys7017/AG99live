from __future__ import annotations

import contextlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .client import VTSClient


PLUGIN_NAME = "AG99live VTS Data Recorder"
PLUGIN_DEVELOPER = "AG99live"


class VTSAuthenticationError(RuntimeError):
    """Raised when the local VTube Studio plugin cannot be authenticated."""


class TokenStore:
    """Small local token store deliberately kept outside the repository by default."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def get(self, endpoint: str) -> str | None:
        payload = self._read()
        tokens = payload.get("tokens")
        if not isinstance(tokens, dict):
            return None
        value = tokens.get(endpoint)
        return str(value).strip() if isinstance(value, str) and value.strip() else None

    def save(self, endpoint: str, token: str) -> None:
        normalized_token = str(token or "").strip()
        if not normalized_token:
            raise VTSAuthenticationError("VTube Studio returned an empty authentication token")
        payload = self._read()
        tokens = payload.setdefault("tokens", {})
        if not isinstance(tokens, dict):
            raise VTSAuthenticationError(f"Token file has invalid tokens data: {self.path}")
        tokens[endpoint] = normalized_token
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = self.path.with_suffix(self.path.suffix + ".tmp")
        temporary_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        os.replace(temporary_path, self.path)
        with contextlib.suppress(OSError):
            os.chmod(self.path, 0o600)

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise VTSAuthenticationError(f"Cannot read local VTS token file: {self.path}") from exc
        if not isinstance(payload, dict):
            raise VTSAuthenticationError(f"Token file must contain a JSON object: {self.path}")
        return payload


@dataclass(frozen=True)
class AuthenticationResult:
    reused_saved_token: bool


async def authenticate(
    client: VTSClient,
    token_store: TokenStore,
    *,
    reauthorize: bool = False,
) -> AuthenticationResult:
    saved_token = None if reauthorize else token_store.get(client.endpoint)
    if saved_token is not None:
        response = await client.request(
            "AuthenticationRequest",
            _authentication_payload(saved_token),
        )
        if bool(response.data.get("authenticated")):
            return AuthenticationResult(reused_saved_token=True)
        raise VTSAuthenticationError(
            "The saved VTube Studio token was rejected. Run again with --reauthorize."
        )

    token_response = await client.request(
        "AuthenticationTokenRequest",
        {
            "pluginName": PLUGIN_NAME,
            "pluginDeveloper": PLUGIN_DEVELOPER,
        },
        timeout_seconds=120.0,
    )
    token = str(token_response.data.get("authenticationToken") or "").strip()
    if not token:
        raise VTSAuthenticationError(
            "VTube Studio did not return an authentication token. Approve the plugin request in VTS."
        )
    authentication_response = await client.request(
        "AuthenticationRequest",
        _authentication_payload(token),
    )
    if not bool(authentication_response.data.get("authenticated")):
        reason = str(authentication_response.data.get("reason") or "unknown reason")
        raise VTSAuthenticationError(f"VTube Studio authentication failed: {reason}")
    token_store.save(client.endpoint, token)
    return AuthenticationResult(reused_saved_token=False)


def default_token_path() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    return base / "AG99live" / "vts-data-recorder.json"


def _authentication_payload(token: str) -> dict[str, str]:
    return {
        "pluginName": PLUGIN_NAME,
        "pluginDeveloper": PLUGIN_DEVELOPER,
        "authenticationToken": token,
    }
