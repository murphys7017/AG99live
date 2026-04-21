from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
ADAPTER_SOURCE_ROOT = REPO_ROOT / "adapter"
if str(ADAPTER_SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(ADAPTER_SOURCE_ROOT))


class _NoopLogger:
    def debug(self, *args, **kwargs) -> None:
        return None

    def info(self, *args, **kwargs) -> None:
        return None

    def warning(self, *args, **kwargs) -> None:
        return None

    def error(self, *args, **kwargs) -> None:
        return None

    def exception(self, *args, **kwargs) -> None:
        return None


@pytest.fixture
def install_fake_astrbot(monkeypatch):
    def _install():
        astrbot_module = types.ModuleType("astrbot")
        astrbot_api_module = types.ModuleType("astrbot.api")
        provider_module = types.ModuleType("astrbot.api.provider")

        class Provider:
            pass

        class STTProvider(Provider):
            pass

        astrbot_api_module.logger = _NoopLogger()
        provider_module.Provider = Provider
        provider_module.STTProvider = STTProvider
        astrbot_module.api = astrbot_api_module

        monkeypatch.setitem(sys.modules, "astrbot", astrbot_module)
        monkeypatch.setitem(sys.modules, "astrbot.api", astrbot_api_module)
        monkeypatch.setitem(sys.modules, "astrbot.api.provider", provider_module)

        return Provider, STTProvider

    return _install
