from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass
from typing import Any, Mapping

from .client import VTSClient


@dataclass(frozen=True)
class DiscoveryResult:
    model_loaded: bool
    model_id: str | None
    model_name: str | None
    default_tracking_parameters: list[dict[str, Any]]
    custom_tracking_parameters: list[dict[str, Any]]
    live2d_parameters: list[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return {
            "model_loaded": self.model_loaded,
            "model_id": self.model_id,
            "model_name": self.model_name,
            "default_tracking_parameters": self.default_tracking_parameters,
            "custom_tracking_parameters": self.custom_tracking_parameters,
            "live2d_parameters": self.live2d_parameters,
        }

    def summary(self) -> dict[str, Any]:
        return {
            "model_loaded": self.model_loaded,
            "model_id": self.model_id,
            "model_name": self.model_name,
            "default_tracking_parameter_count": len(self.default_tracking_parameters),
            "custom_tracking_parameter_count": len(self.custom_tracking_parameters),
            "live2d_parameter_count": len(self.live2d_parameters),
        }


async def discover_parameters(client: VTSClient) -> DiscoveryResult:
    tracking_response, live2d_response = await asyncio.gather(
        client.request("InputParameterListRequest"),
        client.request("Live2DParameterListRequest"),
    )
    live_data = live2d_response.data
    return DiscoveryResult(
        model_loaded=bool(live_data.get("modelLoaded")),
        model_id=_optional_text(live_data.get("modelID")),
        model_name=_optional_text(live_data.get("modelName")),
        default_tracking_parameters=_parameter_entries(
            tracking_response.data.get("defaultParameters")
        ),
        custom_tracking_parameters=_parameter_entries(
            tracking_response.data.get("customParameters")
        ),
        live2d_parameters=_parameter_entries(live_data.get("parameters")),
    )


def tracking_values(data: Mapping[str, Any]) -> dict[str, float]:
    values: dict[str, float] = {}
    for key in ("defaultParameters", "customParameters"):
        for parameter in _parameter_entries(data.get(key)):
            name = _optional_text(parameter.get("name"))
            value = _finite_float(parameter.get("value"))
            if name is not None and value is not None:
                values[name] = value
    return values


def live2d_values(data: Mapping[str, Any]) -> dict[str, float]:
    values: dict[str, float] = {}
    for parameter in _parameter_entries(data.get("parameters")):
        name = _optional_text(parameter.get("name"))
        value = _finite_float(parameter.get("value"))
        if name is not None and value is not None:
            values[name] = value
    return values


def live2d_model_identity(data: Mapping[str, Any]) -> tuple[str | None, str | None]:
    return _optional_text(data.get("modelID")), _optional_text(data.get("modelName"))


def _parameter_entries(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [dict(item) for item in value if isinstance(item, Mapping)]


def _optional_text(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def _finite_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        converted = float(value)
    except (TypeError, ValueError):
        return None
    return converted if math.isfinite(converted) else None
