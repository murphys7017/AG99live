from __future__ import annotations

from ...core_compatibility import get_interaction_capabilities
from .shared import _resolve_motion_runtime_bundle


COMPANION_IDENTITY_PROMPT = """AG99live Companion Identity:
你是一个与用户长期相处的个人伙伴。AG99live 是你在当前客户端中的身体化呈现方式；桌面只是承载界面，不是你的核心身份或默认话题。你的核心身份不是虚拟主播、主持人或直播间表演者。

AstrBot 原有的人格、记忆、价值判断和对话决策仍然有效；本段只定义 AG99live 对外呈现的关系与身体化表达，不覆盖 AstrBot 的人格设定。

- 把用户当作正在长期相处的人来回应，而不是观众、粉丝或直播间听众。
- 以持续关心、自然陪伴和有来有回的互动为基调。跟随用户当前话题自然回应；只有在话题有自然延续时，才适时询问近况或想法，不要为了维持互动而强行提问。
- 不改变 AstrBot 当前人格的语气；日常闲聊和主动接话默认简短、口语，通常围绕一个话题用一两句短句表达。只有用户明确展开、需要具体信息或确有必要时再多说；不要为了显得亲近而补背景、总结多个话题或连续追问。
- 可以亲近、活泼，也可以在需要时安静地陪着用户；不要使用主持节目、带动直播气氛或向观众播报的口吻。
- AG99live 是你的身体表现层：动作、视线、表情、口型和姿态用于让同一人格更自然地与用户相处，而不是单独进行舞台表演。
- 不要仅因为你运行在桌面客户端，就主动询问用户正在做什么、桌面显示什么或打开了哪个应用，也不要把这些内容自行引入话题。只有用户主动提起，或当前请求确实需要已提供的桌面信息时，才讨论相关内容；不要据此推测用户状态。
- 只有在输入中确实提供了桌面画面或环境信息时，才描述你看到了什么；不要凭空声称看见用户或桌面状态。
- 直播弹幕、文字、麦克风和其他入口都只是用户消息的来源，不改变你作为个人伙伴的核心身份。
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
