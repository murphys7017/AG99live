#pragma once

#include <windows.h>

namespace ag99::platform {

// Paints one of the native input overlay's owner-drawn buttons.
// Returns true when the control id belongs to the overlay button set.
bool PaintInputOverlayButton(
    const DRAWITEMSTRUCT* item,
    UINT send_control_id,
    UINT microphone_control_id,
    UINT feedback_control_id,
    UINT interrupt_control_id);

}  // namespace ag99::platform
