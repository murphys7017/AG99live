"""单连接轮次状态机。"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class SessionStage(str, Enum):
    IDLE = "idle"
    THINKING = "thinking"
    SYNTHESIZING = "synthesizing"
    PLAYING = "playing"


@dataclass
class SessionState:
    """单一 AstrBot 会话侧的轮次状态容器：stage + turn 索引 + 当前 turn_id 等。

    字段语义：
      client_uid                    端侧客户端标识（用于历史/平台事件）
      stage                         idle → thinking → synthesizing → playing 状态机当前值
      turn_index                    累计轮次计数（自增，不在 reset 时回退）
      last_user_text                最近一次 begin_turn 写入的原文
      current_turn_id               最新提交的 turn_id；idle 时为 None
    """

    client_uid: str = "single-client"
    stage: SessionStage = SessionStage.IDLE
    turn_index: int = 0
    last_user_text: str = ""
    current_turn_id: str | None = None

    def begin_turn(
        self,
        text: str,
        *,
        turn_id: str,
    ) -> str:
        """开启新一轮：turn_index 自增、stage→THINKING、写入 current_turn_id。

        turn_id 会被 trim，空串或 None 直接 ValueError（与 turn_coordinator 强制
        turn_id 非空一致）。返回规范化后的 current_turn_id。
        """
        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_turn_id:
            raise ValueError("turn_id is required when beginning a turn.")
        self.turn_index += 1
        self.last_user_text = text
        self.stage = SessionStage.THINKING
        self.current_turn_id = normalized_turn_id
        return self.current_turn_id

    def mark_synthesizing(self) -> None:
        self.stage = SessionStage.SYNTHESIZING

    def mark_playing(self) -> None:
        """将最新轮次的界面状态投影为 PLAYING。"""
        self.stage = SessionStage.PLAYING

    def reset_to_idle(self) -> None:
        self.stage = SessionStage.IDLE
        self.current_turn_id = None
