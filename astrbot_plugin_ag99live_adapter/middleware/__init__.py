from typing import Any


def register_ag99live_interaction_contributors(context: Any) -> None:
    from .interaction_motion import (
        register_ag99live_interaction_contributors as _register_motion_contributors,
    )
    from .remote_operator import register_remote_operator_interaction_contributors

    _register_motion_contributors(context)
    register_remote_operator_interaction_contributors(context)

__all__ = ["register_ag99live_interaction_contributors"]
