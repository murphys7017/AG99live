"""单连接轮次身份与计数。"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class SessionState:
    """单连接轮次身份与计数，不是权威的多轮生命周期存储。

    AstrBot 负责输入及 Personal Runtime 队列；TurnIdentityMap、待发送输出段和
    前端 PlaybackTimeline 分别保有按轮次的真实关联与播放状态。current_turn_id
    只用于单连接的当前轮次关联，不能用来拒绝输入、关联历史轮次，或驱动跨轮清理。

    字段语义：
      client_uid                    端侧客户端标识（用于历史/平台事件）
      turn_index                    累计轮次计数（自增，不在 reset 时回退）
      current_turn_id               最新提交轮次；idle 时为 None
    """

    client_uid: str = "single-client"
    turn_index: int = 0
    current_turn_id: str | None = None

    def begin_turn(
        self,
        _text: str,
        *,
        turn_id: str,
    ) -> str:
        """开启新一轮：turn_index 自增并写入 current_turn_id。

        turn_id 会被 trim，空串或 None 直接 ValueError（与 turn_coordinator 强制
        turn_id 非空一致）。返回规范化后的 current_turn_id。
        """
        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_turn_id:
            raise ValueError("turn_id is required when beginning a turn.")
        self.turn_index += 1
        self.current_turn_id = normalized_turn_id
        return self.current_turn_id

    def reset_to_idle(self) -> None:
        self.current_turn_id = None
