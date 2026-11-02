"""Small DSH composition root using the shared InteractionOrchestrator."""

from __future__ import annotations

from dataclasses import dataclass

from ...providers.contracts import (
    AvatarOutputPort,
    MotionProvider,
    SttProvider,
    TtsProvider,
)
from ...runtime.conversation_event_assembler import TextConversationEventAssembler
from ...runtime.interaction_orchestrator import InteractionOrchestrator, ProviderEventSink
from .conversation_provider import DshConversationCallbacks, DshConversationProvider


@dataclass(frozen=True)
class DshConversationRuntime:
    provider: DshConversationProvider
    orchestrator: InteractionOrchestrator
    assembler: TextConversationEventAssembler

    @classmethod
    def build(
        cls,
        *,
        callbacks: DshConversationCallbacks,
        output_port: AvatarOutputPort,
        tts_provider: TtsProvider,
        motion_provider: MotionProvider,
        stt_provider: SttProvider | None = None,
        event_sink: ProviderEventSink | None = None,
    ) -> "DshConversationRuntime":
        provider = DshConversationProvider(callbacks)
        assembler = TextConversationEventAssembler(output_port)
        orchestrator = InteractionOrchestrator(
            conversation_provider=provider,
            stt_provider=stt_provider,
            tts_provider=tts_provider,
            motion_provider=motion_provider,
            output_port=output_port,
            event_sink=event_sink,
        )
        orchestrator.attach_conversation_event_assembler(assembler)
        orchestrator.start()
        return cls(
            provider=provider,
            orchestrator=orchestrator,
            assembler=assembler,
        )


__all__ = ["DshConversationRuntime"]
