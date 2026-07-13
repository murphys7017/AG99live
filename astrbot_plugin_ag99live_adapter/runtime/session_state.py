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
      waiting_for_playback_complete 等待前端 control.playback_finished 的标志
      output_queue_closed           输出队列已关闭（与 control.synth_finished 配套）
      output_queue_closing_turn_id  正在发送 control.synth_finished 的轮次所有权
      current_turn_id               正在处理的 turn_id；idle 时为 None
    """

    client_uid: str = "single-client"
    stage: SessionStage = SessionStage.IDLE
    turn_index: int = 0
    last_user_text: str = ""
    waiting_for_playback_complete: bool = False
    output_queue_closed: bool = False
    output_queue_closing_turn_id: str | None = None
    current_turn_id: str | None = None

    def begin_turn(
        self,
        text: str,
        *,
        turn_id: str,
    ) -> str:
        """开启新一轮：turn_index 自增、stage→THINKING、清两个标志位、写入 current_turn_id。

        turn_id 会被 trim，空串或 None 直接 ValueError（与 turn_coordinator 强制
        turn_id 非空一致）。返回规范化后的 current_turn_id。
        """
        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_turn_id:
            raise ValueError("turn_id is required when beginning a turn.")
        self.turn_index += 1
        self.last_user_text = text
        self.stage = SessionStage.THINKING
        self.waiting_for_playback_complete = False
        self.output_queue_closed = False
        self.output_queue_closing_turn_id = None
        self.current_turn_id = normalized_turn_id
        return self.current_turn_id

    def mark_synthesizing(self) -> None:
        self.stage = SessionStage.SYNTHESIZING

    def mark_playing(self) -> None:
        """进入 PLAYING 阶段，并置 waiting_for_playback_complete=True。

        此时 turn_coordinator 等待前端的 control.playback_finished；收到后由
        mark_playback_complete 切回 idle。
        """
        self.stage = SessionStage.PLAYING
        self.waiting_for_playback_complete = True

    def begin_output_queue_close(self, turn_id: str) -> bool:
        """获取输出队列关闭所有权，已关闭或正在关闭时返回 False。"""
        normalized_turn_id = str(turn_id or "").strip()
        if not normalized_turn_id or normalized_turn_id != self.current_turn_id:
            raise RuntimeError("output_queue_close_turn_mismatch")
        if self.output_queue_closed or self.output_queue_closing_turn_id is not None:
            return False
        self.output_queue_closing_turn_id = normalized_turn_id
        return True

    def complete_output_queue_close(self, turn_id: str) -> None:
        """仅在 control.synth_finished 发送成功后提交关闭状态。"""
        if (
            self.output_queue_closing_turn_id != turn_id
            or self.current_turn_id != turn_id
        ):
            raise RuntimeError("output_queue_close_turn_mismatch")
        self.output_queue_closing_turn_id = None
        self.output_queue_closed = True

    def abort_output_queue_close(self, turn_id: str) -> None:
        """发送失败时释放关闭所有权，允许上层显式重试。"""
        if self.output_queue_closing_turn_id == turn_id:
            self.output_queue_closing_turn_id = None

    def mark_playback_complete(self) -> None:
        """完成收口：清 waiting_for_playback_complete 与 output_queue_closed，
        stage→IDLE，current_turn_id=None。比 reset_to_idle 多一步：不需要用户
        主动调用，与收到 control.playback_finished 配套。
        """
        self.waiting_for_playback_complete = False
        self.output_queue_closed = False
        self.output_queue_closing_turn_id = None
        self.stage = SessionStage.IDLE
        self.current_turn_id = None

    def reset_to_idle(self) -> None:
        self.waiting_for_playback_complete = False
        self.output_queue_closed = False
        self.output_queue_closing_turn_id = None
        self.stage = SessionStage.IDLE
        self.current_turn_id = None
