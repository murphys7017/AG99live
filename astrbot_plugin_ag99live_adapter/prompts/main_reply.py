from __future__ import annotations


def build_main_llm_user_text(user_text: str) -> str:
    """Build the user-visible text for the primary chat model.

    In split-after-reply mode this intentionally returns the original user text:
    motion control is handled by a second provider request after the main reply.
    """

    return str(user_text or "").rstrip()

