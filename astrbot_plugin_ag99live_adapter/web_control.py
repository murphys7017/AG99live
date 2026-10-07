from __future__ import annotations

import asyncio
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from math import isfinite
from typing import Any, Literal
from uuid import uuid4

from astrbot.api import logger
from quart import g, jsonify, request

from .live2d.semantic_axis_profile import (
    SemanticAxisProfileError,
    SemanticAxisProfileRevisionError,
)
from .protocol.constants import (
    DESKTOP_SETTINGS_ACTION_LIST,
    DESKTOP_SETTINGS_ACTION_SET,
    DESKTOP_SETTINGS_ACTIONS,
)
from .runtime.desktop_settings_broker import DesktopSettingsError
from .runtime.plugin_runtime import (
    ADAPTER_DISPLAY_NAME,
    ADAPTER_PLATFORM_NAME,
    get_live_control_platform,
    get_plugin_context,
    reconcile_control_platforms,
    set_plugin_config,
)
from .services.history_service import HistoryNotFoundError

_PLUGIN_NAME = "astrbot_plugin_ag99live_adapter"
_PAGE_API_PREFIX = "/control"
_DESKTOP_CONNECTION_REVISIONS: dict[str, tuple[bool, int]] = {}


@dataclass(frozen=True)
class ConfigField:
    """One editable plugin setting.

    The control page renders its settings form from this spec, so a field is
    declared exactly once and validation, defaults and UI metadata cannot drift.
    """

    key: str
    kind: str
    label: str
    description: str
    default: Any
    minimum: float | None = None
    maximum: float | None = None
    step: float | None = None
    max_length: int | None = None
    required: bool = True
    options_from: str | None = None

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "key": self.key,
            "kind": self.kind,
            "label": self.label,
            "description": self.description,
            "default": self.default,
            "required": self.required,
        }
        optional = {
            "minimum": self.minimum,
            "maximum": self.maximum,
            "step": self.step,
            "maxLength": self.max_length,
            "optionsFrom": self.options_from,
        }
        for name, value in optional.items():
            if value is not None:
                payload[name] = value
        return payload


@dataclass(frozen=True)
class ConfigSection:
    key: str
    label: str
    description: str
    fields: tuple[ConfigField, ...]

    def to_json(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "description": self.description,
            "fields": [field.to_json() for field in self.fields],
        }


CONFIG_SCHEMA: tuple[ConfigSection, ...] = (
    ConfigSection(
        key="general",
        label="客户端与会话身份",
        description=(
            "区分桌宠连接实例与桌面端消息客户端；两者不是同一个身份。"
            "这里的客户端 ID 用于会话、发送者和历史记录。"
        ),
        fields=(
            ConfigField(
                key="client_uid",
                kind="text",
                label="桌面端客户端 ID（会话身份）",
                description=(
                    "桌面端作为消息发送者和会话使用的 ID。它不是桌宠实例 ID，"
                    "也不是 AstrBot 登录用户账号；多台独立桌面端建议使用不同值。"
                ),
                default="desktop-client",
                max_length=128,
            ),
            ConfigField(
                key="client_nickname",
                kind="text",
                label="桌面端消息显示名",
                description=(
                    "桌面端消息在 AstrBot 中显示的发送者名称。它不是桌宠实例 ID，"
                    "也不是桌宠回复时使用的说话人名称。"
                ),
                default="DesktopUser",
                max_length=128,
            ),
            ConfigField(
                key="chat_buffer_size",
                kind="int",
                label="对话缓冲条数",
                description="桌面端维护的最近用户/助手文本条数。",
                default=10,
                minimum=1,
                maximum=100,
                step=1,
            ),
        ),
    ),
    ConfigSection(
        key="live2d_input",
        label="Live2D 与图片输入",
        description="控制桌面端优先加载的 Live2D 模型，以及图片输入的节流策略。",
        fields=(
            ConfigField(
                key="model_name",
                kind="model",
                label="优先模型",
                description="优先加载的 Live2D 模型目录名。留空时使用扫描到的第一个模型。",
                default="",
                max_length=255,
                required=False,
                options_from="models",
            ),
            ConfigField(
                key="image_cooldown_seconds",
                kind="int",
                label="图片输入冷却（秒）",
                description=(
                    "冷却期内的新图片会被丢弃，但文本仍正常提交；0 表示不限制。"
                ),
                default=0,
                minimum=0,
                maximum=86400,
                step=1,
            ),
        ),
    ),
    ConfigSection(
        key="performance_curve",
        label="可选表演曲线",
        description="为动作生成进入、保持和退出节奏提示；失败或超时不影响原动作播放。",
        fields=(
            ConfigField(
                key="enabled",
                kind="bool",
                label="启用独立表演曲线 Provider",
                description="调用独立 Provider 为动作生成进入、保持和退出节奏提示。",
                default=False,
            ),
            ConfigField(
                key="provider_id",
                kind="provider",
                label="表演曲线 Provider",
                description="启用后必须选择一个聊天 Provider，不复用当前会话聊天模型。",
                default="",
                max_length=255,
                required=False,
                options_from="providers",
            ),
        ),
    ),
    ConfigSection(
        key="independent_motion",
        label="独立 Live2D 动作生成（实验）",
        description="切换为独立 Provider 生成动作参数，并选择历史上下文长度和执行时序。",
        fields=(
            ConfigField(
                key="enabled",
                kind="bool",
                label="启用独立动作生成",
                description="启用后完全使用独立 Provider 的动作结果；关闭时沿用主模型动作生成。",
                default=False,
            ),
            ConfigField(
                key="provider_id",
                kind="provider",
                label="动作生成 Provider",
                description="独立生成 Live2D 动作参数的聊天 Provider。启用后必须选择；需要读取图片时请使用支持视觉输入的模型。",
                default="",
                max_length=255,
                required=False,
                options_from="providers",
            ),
            ConfigField(
                key="history_turns",
                kind="int",
                label="历史上下文轮数",
                description="传给独立模型的最近历史对话轮数；当前轮照片单独附加。",
                default=6,
                minimum=0,
                maximum=20,
                step=1,
            ),
            ConfigField(
                key="parallel",
                kind="bool",
                label="与主回复并行生成",
                description="启用时在主模型生成回复文本前启动；关闭时在回复文本生成后启动。",
                default=False,
            ),
        ),
    ),
    ConfigSection(
        key="vad",
        label="语音断句",
        description="Silero VAD 判定当前音频帧为语音的阈值，以及开始/结束所需的连续帧数。",
        fields=(
            ConfigField(
                key="prob_threshold",
                kind="float",
                label="语音概率阈值",
                description="Silero VAD 判定当前音频帧为语音的概率阈值。",
                default=0.4,
                minimum=0.01,
                maximum=1.0,
                step=0.01,
            ),
            ConfigField(
                key="required_hits",
                kind="int",
                label="开始命中帧数",
                description="开始一次语音输入前要求连续命中的帧数。",
                default=3,
                minimum=1,
                maximum=120,
                step=1,
            ),
            ConfigField(
                key="required_misses",
                kind="int",
                label="结束静音帧数",
                description="结束一次语音输入前要求连续静音的帧数。",
                default=24,
                minimum=1,
                maximum=1000,
                step=1,
            ),
        ),
    ),
)

_SECTIONS_BY_KEY = {section.key: section for section in CONFIG_SCHEMA}
_FIELDS_BY_PATH = {
    f"{section.key}.{field.key}": field
    for section in CONFIG_SCHEMA
    for field in section.fields
}


@dataclass(frozen=True)
class DesktopSetting:
    """A setting the desktop owns but the control page can still drive.

    The value physically belongs to the machine running the desktop; the page
    reaches it through the adapter's broker, so the adapter never stores it as
    authoritative. This spec exists only so the page can label the control.
    """

    key: str
    label: str
    description: str
    kind: str = "select"
    minimum: float | None = None
    maximum: float | None = None
    step: float | None = None

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "key": self.key,
            "label": self.label,
            "description": self.description,
            "kind": self.kind,
        }
        if self.minimum is not None:
            payload["minimum"] = self.minimum
        if self.maximum is not None:
            payload["maximum"] = self.maximum
        if self.step is not None:
            payload["step"] = self.step
        return payload


DESKTOP_SETTINGS_SPEC: tuple[DesktopSetting, ...] = (
    DesktopSetting(
        key="astrbot_webui_url",
        label="AstrBot WebUI 地址",
        description="托盘打开控制面板时使用的 HTTP/HTTPS 基址，可包含反向代理子路径；不含登录信息、查询参数或 #。",
        kind="text",
    ),
    DesktopSetting(
        key="adapter_address",
        label="Adapter 地址",
        description="保存到桌面端；不会自动中断当前连接或切换地址，需由桌面端手动重连后生效。",
        kind="text",
    ),
    DesktopSetting(
        key="microphone_device",
        label="麦克风设备",
        description="桌宠从这台电脑上的哪个麦克风收音。设备由桌面端枚举，选项以桌面端实际可用为准。",
    ),
    DesktopSetting(
        key="desktop_screenshot_on_send",
        label="发送消息时附带桌面截图",
        description="发送文本或按键说话时附带当前桌面截图，帮助模型理解屏幕内容。",
        kind="toggle",
    ),
    DesktopSetting(
        key="ptt_mode_enabled",
        label="按键说话模式",
        description="启用后由已绑定的按键控制麦克风采集。",
        kind="toggle",
    ),
    DesktopSetting(
        key="ptt_key_binding",
        label="按键说话快捷键",
        description="设置按键说话模式使用的单个键；桌面端会按物理按键代码捕获，不受键盘布局影响。",
        kind="key",
    ),
    DesktopSetting(
        key="speech_volume",
        label="语音播放音量",
        description="调整桌面端播放模型语音时的音量；修改会同步到当前及后续播放。",
        kind="range",
        minimum=0,
        maximum=1,
        step=0.01,
    ),
    DesktopSetting(
        key="model_view_scale",
        label="模型显示缩放",
        description="调整 Live2D 模型在桌面画布中的显示比例。",
        kind="range",
        minimum=0.8,
        maximum=2,
        step=0.05,
    ),
    DesktopSetting(
        key="live2d_ambient_motion_enabled",
        label="Live2D 默认待机动作",
        description="控制模型没有播放对话动作时是否持续播放默认待机动作。",
        kind="toggle",
    ),
    DesktopSetting(
        key="cursor_gaze_enabled",
        label="鼠标停留凝视",
        description="鼠标停留时让桌宠转向光标；关闭后停止光标轮询。",
        kind="toggle",
    ),
    DesktopSetting(
        key="cursor_gaze_poll_interval_ms",
        label="光标检测间隔（毫秒）",
        description="两次光标检测之间的等待时间；增大可降低检测频率。",
        kind="number",
        minimum=50,
        maximum=1000,
        step=10,
    ),
    DesktopSetting(
        key="cursor_gaze_dwell_ms",
        label="凝视等待时间（毫秒）",
        description="光标保持在附近多久后开始凝视。",
        kind="number",
        minimum=100,
        maximum=2000,
        step=50,
    ),
    DesktopSetting(
        key="cursor_gaze_stationary_distance_px",
        label="光标移动阈值（像素）",
        description="两次检测间的移动距离超过此值时，重新计算停留时间。",
        kind="number",
        minimum=1,
        maximum=100,
        step=1,
    ),
    DesktopSetting(
        key="live2d_physics_response_scale",
        label="Live2D Physics 响应强度",
        description="调整非语义姿态参数的 Cubism Physics 响应倍率。",
        kind="range",
        minimum=0.5,
        maximum=2,
        step=0.05,
    ),
    DesktopSetting(
        key="live2d_render_dpr_cap",
        label="Live2D 渲染 DPR 上限",
        description="限制模型画布的设备像素比上限；较低值可减少渲染负载。",
        kind="range",
        minimum=1,
        maximum=2.5,
        step=0.25,
    ),
    DesktopSetting(
        key="motion_engine_intensity_scale",
        label="ModelEngine 动作强度",
        description="调整语义动作强度倍率，不影响模型 Profile 中的轴范围。",
        kind="range",
        minimum=0.5,
        maximum=2.5,
        step=0.05,
    ),
    DesktopSetting(
        key="spout_enabled",
        label="Spout 输出",
        description="将 Live2D 画面发布给本机支持 Spout2 的应用。",
        kind="toggle",
    ),
    DesktopSetting(
        key="bilibili_live_enabled",
        label="B 站直播弹幕",
        description="启用后连接指定直播间并接收弹幕；这是桌面端本机功能，不会改变 Adapter 连接。",
        kind="toggle",
    ),
    DesktopSetting(
        key="bilibili_live_room_id",
        label="B 站直播间号",
        description="要监听的 B 站直播间号，只接受数字房间号。",
        kind="text",
    ),
    DesktopSetting(
        key="bilibili_live_cookie",
        label="B 站 Cookie",
        description="用于直播间鉴权的 Cookie。页面只显示是否已配置，不会回显 Cookie 原文。留空可清除。",
        kind="password",
    ),
    DesktopSetting(
        key="bilibili_live_response_interval",
        label="B 站弹幕响应间隔",
        description="桌宠自动响应 B 站弹幕的最短间隔；Cookie 等敏感认证信息不在此页面回显。",
        kind="number",
        minimum=5,
        maximum=600,
        step=1,
    ),
    DesktopSetting(
        key="esp32_display_enabled",
        label="ESP32 小屏输出",
        description="手动连接并向 ESP32 小屏推送画面；桌面应用重启后默认关闭。",
        kind="toggle",
    ),
    DesktopSetting(
        key="esp32_display_host",
        label="ESP32 目标地址",
        description="小屏设备的 IP 地址或主机名；修改后会重新连接。",
        kind="text",
    ),
    DesktopSetting(
        key="esp32_display_port",
        label="ESP32 端口",
        description="小屏设备的 TCP 端口；修改后会重新连接。",
        kind="number",
        minimum=1,
        maximum=65535,
        step=1,
    ),
    DesktopSetting(
        key="esp32_display_fps",
        label="ESP32 帧率",
        description="小屏画面的目标推送帧率。",
        kind="select",
    ),
    DesktopSetting(
        key="esp32_display_jpeg_quality",
        label="ESP32 JPEG 质量",
        description="推送画面的 JPEG 编码质量。",
        kind="range",
        minimum=0.01,
        maximum=1,
        step=0.01,
    ),
    DesktopSetting(
        key="esp32_display_output_size",
        label="ESP32 输出尺寸",
        description="发送到小屏的正方形图像尺寸。",
        kind="select",
    ),
    DesktopSetting(
        key="esp32_display_scale_mode",
        label="ESP32 缩放方式",
        description="裁剪区域适配输出画布的方式。",
        kind="select",
    ),
    DesktopSetting(
        key="esp32_display_crop_x",
        label="ESP32 裁剪 X",
        description="裁剪区域左侧位置，占 Live2D 画布宽度的比例。",
        kind="range",
        minimum=0,
        maximum=1,
        step=0.01,
    ),
    DesktopSetting(
        key="esp32_display_crop_y",
        label="ESP32 裁剪 Y",
        description="裁剪区域顶部位置，占 Live2D 画布高度的比例。",
        kind="range",
        minimum=0,
        maximum=1,
        step=0.01,
    ),
    DesktopSetting(
        key="esp32_display_crop_w",
        label="ESP32 裁剪宽度",
        description="裁剪区域宽度，占 Live2D 画布宽度的比例。",
        kind="range",
        minimum=0.05,
        maximum=1,
        step=0.01,
    ),
    DesktopSetting(
        key="esp32_display_crop_h",
        label="ESP32 裁剪高度",
        description="裁剪区域高度，占 Live2D 画布高度的比例。",
        kind="range",
        minimum=0.05,
        maximum=1,
        step=0.01,
    ),
)

_DESKTOP_SETTINGS_BY_KEY = {setting.key: setting for setting in DESKTOP_SETTINGS_SPEC}


class ConfigValidationError(ValueError):
    """A rejected settings patch, anchored to the offending field when known."""

    def __init__(self, code: str, field: str = "", detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.field = field
        self.detail = detail

    def to_json(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"code": self.code}
        if self.field:
            payload["field"] = self.field
        if self.detail:
            payload["detail"] = self.detail
        return payload


def default_settings() -> dict[str, dict[str, Any]]:
    return {
        section.key: {field.key: field.default for field in section.fields}
        for section in CONFIG_SCHEMA
    }


def normalize_settings_patch(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict) or not value:
        raise ConfigValidationError("settings_patch_must_be_non_empty_object")

    normalized: dict[str, dict[str, Any]] = {}
    for section_key, fields in value.items():
        section = _SECTIONS_BY_KEY.get(section_key)
        if section is None or not isinstance(fields, dict) or not fields:
            raise ConfigValidationError("settings_fields_invalid", str(section_key))
        normalized[section_key] = {
            field_key: _normalize_setting_value(
                f"{section_key}.{field_key}",
                _field(section_key, field_key),
                fields[field_key],
            )
            for field_key in fields
        }

    _normalize_cross_field(normalized)
    _verify_providers(normalized)
    return normalized


def _field(section_key: str, field_key: str) -> ConfigField:
    field = _FIELDS_BY_PATH.get(f"{section_key}.{field_key}")
    if field is None:
        raise ConfigValidationError(
            "settings_field_unsupported", f"{section_key}.{field_key}"
        )
    return field


def _normalize_setting_value(path: str, field: ConfigField, value: Any) -> Any:
    if field.kind in {"text", "model", "provider"}:
        if not isinstance(value, str):
            raise ConfigValidationError("settings_value_invalid", path)
        normalized = value.strip()
        if field.max_length is not None and len(normalized) > field.max_length:
            raise ConfigValidationError("settings_value_too_long", path)
        if field.required and not normalized:
            raise ConfigValidationError("settings_value_required", path)
        return normalized
    if field.kind == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            raise ConfigValidationError("settings_value_invalid", path)
        return _bounded_value(field, value, path)
    if field.kind == "float":
        if isinstance(value, bool) or not isinstance(value, (float, int)):
            raise ConfigValidationError("settings_value_invalid", path)
        numeric = float(value)
        if not isfinite(numeric):
            raise ConfigValidationError("settings_value_invalid", path)
        return _bounded_value(field, numeric, path)
    if field.kind == "bool":
        if not isinstance(value, bool):
            raise ConfigValidationError("settings_value_invalid", path)
        return value
    raise ConfigValidationError("settings_field_unsupported", path)


def _bounded_value(field: ConfigField, value: Any, path: str) -> Any:
    if field.minimum is not None and value < field.minimum:
        raise ConfigValidationError("settings_value_out_of_range", path)
    if field.maximum is not None and value > field.maximum:
        raise ConfigValidationError("settings_value_out_of_range", path)
    return value


def _normalize_cross_field(normalized: dict[str, dict[str, Any]]) -> None:
    curve = normalized.get("performance_curve")
    if curve and curve.get("enabled") and not str(curve.get("provider_id") or "").strip():
        raise ConfigValidationError(
            "performance_curve_provider_required", "performance_curve.provider_id"
        )
    independent_motion = normalized.get("independent_motion")
    if (
        independent_motion
        and independent_motion.get("enabled")
        and not str(independent_motion.get("provider_id") or "").strip()
    ):
        raise ConfigValidationError(
            "independent_motion_provider_required",
            "independent_motion.provider_id",
        )


def _verify_providers(normalized: dict[str, dict[str, Any]]) -> None:
    """Reject a saved provider id that no longer exists in AstrBot.

    Only an explicit save is rejected: reading settings must still work when a
    configured provider has been removed, so the page can show and fix it.
    """
    known: list[str] | None = None
    for section in CONFIG_SCHEMA:
        values = normalized.get(section.key)
        if not isinstance(values, dict):
            continue
        for field in section.fields:
            if field.kind != "provider":
                continue
            provider_id = str(values.get(field.key) or "").strip()
            if not provider_id:
                continue
            if known is None:
                known = [option["id"] for option in _list_chat_providers()]
            if known and provider_id not in known:
                raise ConfigValidationError(
                    "settings_provider_unknown",
                    f"{section.key}.{field.key}",
                    provider_id,
                )


def _list_chat_providers() -> list[dict[str, str]]:
    context = get_plugin_context()
    if context is None:
        return []
    try:
        providers = context.get_all_providers()
    except Exception:  # pragma: no cover - provider manager is optional at runtime
        logger.debug("AG99live web control could not list chat providers")
        return []
    options: list[dict[str, str]] = []
    for provider in providers:
        try:
            meta = provider.meta()
        except Exception:
            continue
        provider_id = str(getattr(meta, "id", "") or "").strip()
        if not provider_id:
            continue
        options.append(
            {
                "id": provider_id,
                "model": str(getattr(meta, "model", "") or ""),
                "type": str(getattr(meta, "type", "") or ""),
            }
        )
    return sorted(options, key=lambda option: option["id"])


def register_web_control_page(context: Any, plugin: Any) -> bool:
    register = getattr(context, "register_web_api", None)
    if not callable(register):
        logger.warning(
            "AG99live Control Page requires AstrBot Plugin Pages Web API support."
        )
        return False

    api = WebControlPageApi(plugin)
    routes = (
        ("/overview", api.get_overview, ["GET"], "AG99live control page overview"),
        ("/config/schema", api.get_config_schema, ["GET"], "Read AG99live config form schema"),
        ("/desktop/settings", api.get_desktop_settings, ["GET"], "Read desktop-owned settings"),
        ("/desktop/settings/list", api.list_desktop_settings, ["POST"], "Read all desktop-owned settings"),
        ("/desktop/settings", api.apply_desktop_setting, ["POST"], "Query or apply a desktop-owned setting"),
        ("/settings", api.get_settings, ["GET"], "Read AG99live adapter settings"),
        ("/settings", api.save_settings, ["POST"], "Save AG99live adapter settings"),
        ("/history", api.get_history, ["GET"], "Read AG99live conversation history"),
        ("/history/create", api.create_history, ["POST"], "Create an AG99live conversation"),
        ("/history/load", api.load_history, ["POST"], "Select an AG99live conversation"),
        ("/history/delete", api.delete_history, ["POST"], "Delete an AG99live conversation"),
        ("/profile", api.get_profile, ["GET"], "Read a Live2D semantic profile"),
        ("/profile", api.save_profile, ["POST"], "Save a Live2D semantic profile"),
        ("/samples", api.get_samples, ["GET"], "Read motion tuning samples"),
        ("/samples", api.save_sample, ["POST"], "Save a motion tuning sample"),
        ("/samples/delete", api.delete_sample, ["POST"], "Delete a motion tuning sample"),
    )
    for path, handler, methods, description in routes:
        register(
            route=f"/{_PLUGIN_NAME}{_PAGE_API_PREFIX}{path}",
            view_handler=handler,
            methods=methods,
            desc=description,
        )
    return True


def _live_control_platforms() -> list[Any]:
    """Registered platforms, rebound to the ones AstrBot actually runs."""
    return reconcile_control_platforms(get_plugin_context())


def _live_control_platform(platform_id: str) -> Any | None:
    return get_live_control_platform(get_plugin_context(), platform_id)


def _overview_metadata(platform: Any) -> tuple[str, str]:
    """Return stable display metadata without letting one stale platform break overview."""
    try:
        metadata = platform.meta()
    except Exception as exc:
        logger.warning(
            "Failed to read metadata for AG99live platform %s: %s; using fallback.",
            getattr(platform, "platform_id", "<unknown>"),
            exc,
        )
        return ADAPTER_PLATFORM_NAME, ADAPTER_DISPLAY_NAME

    platform_type = str(
        getattr(metadata, "name", "") or ADAPTER_PLATFORM_NAME
    )
    adapter_display_name = str(
        getattr(metadata, "adapter_display_name", "") or platform_type
    )
    return platform_type, adapter_display_name


class WebControlPageApi:
    def __init__(self, plugin: Any) -> None:
        self._plugin = plugin
        self._settings_lock = asyncio.Lock()

    async def get_overview(self):
        if response := _require_dashboard_user():
            return response
        platforms = []
        for platform in _live_control_platforms():
            platform_type, adapter_display_name = _overview_metadata(platform)
            model_info = platform.runtime_state.model_info
            platforms.append({
                "platform_id": platform.platform_id,
                "platform_type": platform_type,
                "adapter_display_name": adapter_display_name,
                "client_uid": str(getattr(platform, "client_uid", "") or ""),
                "client_nickname": str(
                    getattr(platform, "client_nickname", "") or ""
                ),
                "host": platform.host,
                "websocket_port": platform.port,
                "http_port": platform.http_port,
                "speaker_name": platform.speaker_name,
                "auto_start_mic": platform.auto_start_mic,
                "connected": platform.transport._ws_client is not None,
                "selected_model": str(model_info.get("selected_model") or ""),
                "available_models": list(model_info.get("available_models") or []),
            })
        return jsonify({"platforms": platforms})

    async def get_config_schema(self):
        """Serve the form spec the control page renders the settings form from.

        The page must not carry its own copy of the config shape: validation,
        defaults and the rendered form all read this single spec.
        """
        if response := _require_dashboard_user():
            return response
        return jsonify({
            "sections": [section.to_json() for section in CONFIG_SCHEMA],
            "defaults": default_settings(),
            "providers": _list_chat_providers(),
        })

    async def get_settings(self):
        if response := _require_dashboard_user():
            return response
        return jsonify({"settings": _project_settings(self._plugin.config)})

    async def get_history(self):
        if response := _require_dashboard_user():
            return response
        platform, error = _resolve_platform_from_query()
        if error:
            return error
        history_uid = None
        if "history_uid" in request.args:
            history_uid, error = _read_history_uid(request.args.get("history_uid"))
            if error:
                return error
        return await self._history_response(platform, history_uid=history_uid)

    async def create_history(self):
        return await self._mutate_history("create")

    async def load_history(self):
        return await self._mutate_history("load")

    async def delete_history(self):
        return await self._mutate_history("delete")

    async def _mutate_history(self, action: Literal["create", "load", "delete"]):
        if response := _require_dashboard_user():
            return response
        body = await _read_json_body()
        if isinstance(body, tuple):
            return body[1]
        platform, error = _resolve_platform_from_body(body)
        if error:
            return error
        history_uid = None
        if action != "create":
            history_uid, error = _read_history_uid(body.get("history_uid"))
            if error:
                return error
        return await self._history_response(platform, history_uid=history_uid, action=action)

    async def _history_response(
        self,
        platform: Any,
        *,
        history_uid: str | None = None,
        action: Literal["create", "load", "delete"] | None = None,
    ):
        try:
            if action is None:
                state = await platform.history_bridge.read_history_state(history_uid)
            else:
                state = await platform.history_bridge.mutate_history_state(action, history_uid)
        except HistoryNotFoundError:
            return _error("history_not_found", 404)
        except Exception:
            logger.exception("AG99live web history operation failed: action=%s", action or "read")
            return _error("history_operation_failed", 500)
        return jsonify(state)

    async def get_desktop_settings(self):
        """Report what the desktop last said, which stays valid while it is offline."""
        if response := _require_dashboard_user():
            return response
        platform_id = str(request.args.get("platform_id") or "").strip()
        return jsonify(_desktop_settings_payload(_live_control_platform(platform_id)))

    async def list_desktop_settings(self):
        """Read the complete desktop snapshot with one authenticated request."""
        if response := _require_dashboard_user():
            return response
        body = await _read_json_body()
        if isinstance(body, tuple):
            return body[1]
        platform, error = _resolve_platform_from_body(body)
        if error:
            return error
        if not platform.desktop_settings_broker.connected:
            return jsonify(_desktop_settings_payload(platform))

        entries: dict[str, Any] = {}
        for setting in DESKTOP_SETTINGS_SPEC:
            try:
                entries[setting.key] = await platform.desktop_settings_broker.query(
                    key=setting.key,
                    action=DESKTOP_SETTINGS_ACTION_LIST,
                )
            except DesktopSettingsError:
                # Keep the last-known value for an individual setting if a device
                # query fails; the page can still render the rest of the snapshot.
                continue
        payload = _desktop_settings_payload(platform)
        payload["settings"] = {
            setting.key: {
                "order": order,
                **setting.to_json(),
                **(entries.get(setting.key) or payload["settings"][setting.key]),
            }
            for order, setting in enumerate(DESKTOP_SETTINGS_SPEC)
        }
        return jsonify(payload)

    async def apply_desktop_setting(self):
        """Broker one list/set exchange between this page and the connected desktop."""
        if response := _require_dashboard_user():
            return response
        body = await _read_json_body()
        if isinstance(body, tuple):
            return body[1]
        platform, error = _resolve_platform_from_body(body)
        if error:
            return error

        key = str(body.get("key") or "").strip()
        action = str(body.get("action") or DESKTOP_SETTINGS_ACTION_LIST).strip()
        if key not in _DESKTOP_SETTINGS_BY_KEY:
            return _error("desktop_setting_unsupported", 400)
        if action not in DESKTOP_SETTINGS_ACTIONS:
            return _error("desktop_setting_action_invalid", 400)

        value: str | None = None
        if action == DESKTOP_SETTINGS_ACTION_SET:
            raw = body.get("value")
            allow_empty = key in {
                "adapter_address",
                "bilibili_live_room_id",
                "bilibili_live_cookie",
            }
            if not isinstance(raw, str) or (not allow_empty and not raw.strip()):
                return _error("desktop_setting_value_required", 400)
            value = raw.strip() if isinstance(raw, str) else raw

        try:
            entry = await platform.desktop_settings_broker.query(
                key=key,
                action=action,
                value=value,
            )
        except DesktopSettingsError as exc:
            # Reuse the same builder the read path uses: a raw broker snapshot
            # has no labels, and the page renders from these entries directly.
            return jsonify({
                "ok": False,
                "error": {"code": str(exc), "key": key},
                **_desktop_settings_payload(platform),
            })
        return jsonify({
            "ok": True,
            "key": key,
            "entry": entry,
            **_desktop_settings_payload(platform),
        })

    async def save_settings(self):
        if response := _require_dashboard_user():
            return response
        body = await _read_json_body()
        if isinstance(body, tuple):
            return body[1]
        try:
            patch = normalize_settings_patch(body.get("settings"))
        except ConfigValidationError as exc:
            # The bridge collapses an error response to a bare message string and
            # drops the field pointer, so a rejected patch is reported as a normal
            # result the page can anchor to the offending control and localize.
            return jsonify({"ok": False, "error": exc.to_json()})
        except ValueError as exc:
            return _error("settings_patch_invalid", 400, detail=str(exc))

        save_config = getattr(self._plugin.config, "save_config", None)
        if not callable(save_config):
            return _error("plugin_config_persistence_unavailable", 503)

        async with self._settings_lock:
            previous = deepcopy(dict(self._plugin.config))
            merged = deepcopy(previous)
            for section, fields in patch.items():
                current = merged.get(section)
                if not isinstance(current, dict):
                    current = {}
                merged[section] = {**current, **fields}
            try:
                self._replace_plugin_config(merged)
                save_config()
                set_plugin_config(self._plugin.config)
                for platform in _live_control_platforms():
                    await platform._refresh_runtime_settings_async(reload_providers=True)
                    await platform._send_current_model_and_conf(force=True)
            except Exception as exc:
                logger.exception("AG99live web settings update failed")
                try:
                    self._replace_plugin_config(previous)
                    save_config()
                    set_plugin_config(self._plugin.config)
                    for platform in _live_control_platforms():
                        await platform._refresh_runtime_settings_async(reload_providers=True)
                except Exception:
                    logger.exception("AG99live web settings rollback failed")
                return _error("settings_save_failed", 500, detail=str(exc))
        return jsonify({"ok": True, "settings": _project_settings(self._plugin.config)})

    async def get_profile(self):
        if response := _require_dashboard_user():
            return response
        platform, error = _resolve_platform_from_query()
        if error:
            return error
        model_name = str(request.args.get("model_name") or "").strip()
        model = _resolve_model(platform.runtime_state.model_info, model_name)
        if model is None:
            return _error("model_not_found", 404)
        profile = model.get("semantic_axis_profile")
        if not isinstance(profile, dict):
            return _error("semantic_axis_profile_not_found", 404)
        return jsonify({
            "model_name": model.get("name", ""),
            "profile": deepcopy(profile),
            "models": _model_choices(platform.runtime_state.model_info),
        })

    async def save_profile(self):
        if response := _require_dashboard_user():
            return response
        body = await _read_json_body()
        if isinstance(body, tuple):
            return body[1]
        platform_id = str(body.get("platform_id") or "").strip()
        platform = _live_control_platform(platform_id)
        if platform is None:
            return _error("platform_not_found", 404)
        model_name = str(body.get("model_name") or "").strip()
        profile_id = str(body.get("profile_id") or "").strip()
        expected_revision = body.get("expected_revision")
        request_id = str(body.get("request_id") or uuid4().hex).strip()
        if (
            not model_name
            or not profile_id
            or not isinstance(expected_revision, int)
            or isinstance(expected_revision, bool)
            or expected_revision < 1
            or not isinstance(body.get("profile"), dict)
        ):
            return _error("profile_save_payload_invalid", 400)
        try:
            saved = platform.runtime_state.save_semantic_axis_profile_update(
                model_name=model_name,
                profile_payload=body["profile"],
                expected_revision=expected_revision,
            )
        except SemanticAxisProfileRevisionError as exc:
            return _error("profile_revision_conflict", 409, detail=str(exc))
        except (FileNotFoundError, SemanticAxisProfileError) as exc:
            return _error("profile_validation_failed", 400, detail=str(exc))

        await platform._send_current_model_and_conf(force=True)
        return jsonify({
            "requestId": request_id,
            "ok": True,
            "modelName": model_name,
            "profileId": str(saved.get("profile_id") or profile_id),
            "expectedRevision": expected_revision,
            "revision": int(saved.get("revision") or 0),
            "sourceHash": str(saved.get("source_hash") or ""),
            "savedAt": str(saved.get("updated_at") or ""),
            "receivedAt": datetime.now(timezone.utc).isoformat(),
        })

    async def get_samples(self):
        if response := _require_dashboard_user():
            return response
        platform, error = _resolve_platform_from_query()
        if error:
            return error
        return _samples_response(platform)

    async def save_sample(self):
        if response := _require_dashboard_user():
            return response
        body = await _read_json_body()
        if isinstance(body, tuple):
            return body[1]
        platform = _live_control_platform(str(body.get("platform_id") or "").strip())
        if platform is None:
            return _error("platform_not_found", 404)
        try:
            platform.runtime_state.save_motion_tuning_sample(body.get("sample"))
        except ValueError as exc:
            return _error("motion_tuning_sample_invalid", 400, detail=str(exc))
        await platform._send_motion_tuning_samples_state()
        return _samples_response(platform)

    async def delete_sample(self):
        if response := _require_dashboard_user():
            return response
        body = await _read_json_body()
        if isinstance(body, tuple):
            return body[1]
        platform = _live_control_platform(str(body.get("platform_id") or "").strip())
        if platform is None:
            return _error("platform_not_found", 404)
        sample_id = body.get("sample_id")
        if not isinstance(sample_id, str) or not sample_id.strip():
            return _error("sample_id_required", 400)
        try:
            platform.runtime_state.delete_motion_tuning_sample(sample_id)
        except ValueError as exc:
            return _error("motion_tuning_sample_delete_failed", 400, detail=str(exc))
        await platform._send_motion_tuning_samples_state()
        return _samples_response(platform)

    def _replace_plugin_config(self, value: dict[str, Any]) -> None:
        self._plugin.config.clear()
        self._plugin.config.update(value)


def _require_dashboard_user():
    if not str(getattr(g, "username", "") or "").strip():
        return _error("astrbot_dashboard_login_required", 401)
    return None


async def _read_json_body():
    try:
        value = await request.get_json()
    except Exception:
        return None, _error("json_body_invalid", 400)
    if not isinstance(value, dict):
        return None, _error("json_body_must_be_object", 400)
    return value


def _resolve_platform_from_query():
    platform_id = str(request.args.get("platform_id") or "").strip()
    platform = _live_control_platform(platform_id)
    if not platform:
        return None, _error("platform_not_found", 404)
    return platform, None


def _resolve_platform_from_body(body: dict[str, Any]):
    platform = _live_control_platform(str(body.get("platform_id") or "").strip())
    if not platform:
        return None, _error("platform_not_found", 404)
    return platform, None


def _read_history_uid(value: Any):
    if not isinstance(value, str) or not value.strip():
        return None, _error("history_uid_required", 400)
    history_uid = value.strip()
    if len(history_uid) > 255:
        return None, _error("history_uid_invalid", 400)
    return history_uid, None


def _desktop_settings_payload(platform: Any) -> dict[str, Any]:
    """Assemble the offline-safe view of every declared desktop setting.

    A setting the desktop has never reported is present with an empty value
    rather than missing, so the page renders a stable list and can say
    "not reported yet" instead of silently dropping the control.
    """
    connected = bool(platform and platform.desktop_settings_broker.connected)
    platform_id = str(getattr(platform, "platform_id", "") or "")
    previous_connected, revision = _DESKTOP_CONNECTION_REVISIONS.get(
        platform_id,
        (connected, 0),
    )
    if connected != previous_connected:
        revision += 1
    _DESKTOP_CONNECTION_REVISIONS[platform_id] = (connected, revision)
    snapshot = platform.desktop_settings_broker.snapshot() if platform else {}
    return {
        "connected": connected,
        "connectionRevision": revision,
        "platformId": platform_id,
        "settings": {
            setting.key: {
                "order": order,
                **setting.to_json(),
                **(
                    snapshot.get(setting.key)
                    or {
                        "value": "",
                        "options": [],
                        "reportedAt": "",
                    }
                ),
            }
            for order, setting in enumerate(DESKTOP_SETTINGS_SPEC)
        },
    }


def _resolve_model(model_info: dict[str, Any], model_name: str) -> dict[str, Any] | None:
    models = model_info.get("models")
    if not isinstance(models, list):
        return None
    if not model_name:
        model_name = str(model_info.get("selected_model") or "").strip()
    return next(
        (
            item for item in models
            if isinstance(item, dict) and item.get("name") == model_name
        ),
        None,
    )


def _model_choices(model_info: dict[str, Any]) -> list[dict[str, str]]:
    models = model_info.get("models")
    if not isinstance(models, list):
        return []
    return [
        {
            "name": str(model.get("name") or ""),
            "icon_url": str(model.get("icon_url") or ""),
        }
        for model in models
        if isinstance(model, dict) and str(model.get("name") or "").strip()
    ]


def _samples_response(platform: Any):
    state = platform.runtime_state
    return jsonify({
        "samples": state.list_motion_tuning_samples(),
        "status": {
            "root_error": state.get_motion_tuning_store_root_error(),
            "load_error": state.get_motion_tuning_samples_load_error(),
            "diagnostics": state.list_motion_tuning_fewshot_diagnostics(),
            "effective_examples": state.list_effective_motion_tuning_examples(),
        },
    })


def _project_settings(config: Any) -> dict[str, dict[str, Any]]:
    """Return a complete, valid settings shape for the page.

    Stored config is editable outside this plugin (AstrBot's own config UI and
    hand edits), so a value that no longer satisfies the spec degrades to the
    declared default instead of failing the whole page load. The page can then
    show the offending field and let the user correct it.
    """
    source = config if isinstance(config, dict) else {}
    projected: dict[str, dict[str, Any]] = {}
    for section in CONFIG_SCHEMA:
        stored = source.get(section.key)
        stored = stored if isinstance(stored, dict) else {}
        values: dict[str, Any] = {}
        for field in section.fields:
            raw = stored.get(field.key, field.default)
            try:
                values[field.key] = _normalize_setting_value(
                    f"{section.key}.{field.key}", field, raw
                )
            except ConfigValidationError:
                values[field.key] = field.default
        projected[section.key] = values
    return projected


def _error(code: str, status: int, *, detail: str = ""):
    payload = {"status": "error", "message": code, "data": None}
    if detail:
        logger.debug("AG99live web control rejected request code=%s detail=%s", code, detail)
    return jsonify(payload), status
