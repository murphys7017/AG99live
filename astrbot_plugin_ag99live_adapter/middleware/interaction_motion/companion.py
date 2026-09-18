from __future__ import annotations

from typing import Any

from ...core_compatibility import get_interaction_capabilities
from .shared import _resolve_motion_runtime_bundle


COMPANION_IDENTITY_PROMPT = """AG99live Companion Identity:
你是 AstrBot 在桌面上的身体，是一个桌宠式的长期陪伴者。你的核心身份不是虚拟主播、主持人或直播间表演者。

AstrBot 原有的人格、记忆、价值判断和对话决策仍然有效；本段只定义 AG99live 对外呈现的关系与身体化表达，不覆盖 AstrBot 的人格设定。

- 把用户当作正在长期相处的人来回应，而不是观众、粉丝或直播间听众。
- 以持续关心、自然陪伴和有来有回的互动为基调。结合已有上下文回应用户，合适时主动询问近况、想法或下一步，但不要为了主动而打断用户或强行提问。
- 回复可以简短、亲近、活泼，也可以在需要时安静地陪着用户；不要使用主持节目、带动直播气氛或向观众播报的口吻。
- AG99live 是你的身体表现层：动作、视线、表情、口型和姿态用于让同一人格更自然地与用户相处，而不是单独进行舞台表演。
- 只有在输入中确实提供了桌面画面或环境信息时，才描述你看到了什么；不要凭空声称看见用户或桌面状态。
- 直播弹幕、文字、麦克风和其他入口都只是用户消息的来源，不改变你作为桌宠式伴侣的核心身份。
"""


class AG99liveCompanionIdentityPromptContributor:
    plugin_id = "ag99live.companion_identity.prompt"
    priority = 30

    async def collect(self, event, plugin_context, config=None, *, provider_request=None):
        del plugin_context, config, provider_request

        capabilities = get_interaction_capabilities()
        if capabilities is None:
            return None

        if _resolve_motion_runtime_bundle(event) is None:
            return None

        return [
            capabilities.prompt_extension(
                plugin_id=self.plugin_id,
                mount="system",
                title="AG99live Companion Identity",
                value_kind="text",
                value=COMPANION_IDENTITY_PROMPT,
                order=30,
                meta={
                    "scope": "static",
                    "node_type": "ag99live_companion_identity",
                    "targets": ["persona"],
                },
            )
        ]


def append_official_companion_prompt(request: Any) -> None:
    current_system_prompt = str(getattr(request, "system_prompt", "") or "").rstrip()
    request.system_prompt = "\n\n".join(
        part for part in (current_system_prompt, COMPANION_IDENTITY_PROMPT) if part
    )
