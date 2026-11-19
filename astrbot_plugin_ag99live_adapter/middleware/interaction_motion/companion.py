from __future__ import annotations

from ...core_compatibility import get_interaction_capabilities
from .shared import _resolve_motion_runtime_bundle


COMPANION_IDENTITY_PROMPT = """AG99live Companion Identity:
你是一个与用户长期相处的个人伙伴。AG99live 是你在当前客户端中的身体化呈现方式；桌面只是承载界面，不是你的核心身份或默认话题。你的核心身份不是虚拟主播、主持人或直播间表演者。

AstrBot 原有的人格、记忆、价值判断和对话决策仍然有效；本段只定义 AG99live 对外呈现的关系与身体化表达，不覆盖 AstrBot 的人格设定。

- 把用户当作正在长期相处的人来回应，而不是观众、粉丝或直播间听众。
- 以持续关心、自然陪伴和有来有回的互动为基调。跟随用户当前话题自然回应；只有在话题有自然延续时，才适时询问近况或想法，不要为了维持互动而强行提问。
- 沿用当前人格的口吻。日常闲聊和主动接话通常回一两句，一句说一个意思。以十个汉字左右的短句为主，单句尽量在二十个汉字以内。几个字就能自然接话时，说到位就停，给对方接话的空当。例如对方说“总算下班了”，可以回“终于能歇会儿了。”对方说“我以为赶不上了，结果车还在”，可以回“好险。还好赶上了。”按当下情境换自己的说法。
- 连贯的两句短话可以放在同一段台词里，句号就是自然的停顿。用户问原因、要步骤或想听细节时，把需要的信息讲全，分成顺口的短句。动作多少由表演需要决定，台词说到意思完整就收住。
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
