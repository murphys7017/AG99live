#include "ag99/native/desktop_presence_runtime.hpp"

#include <windows.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <sstream>
#include <utility>

namespace ag99::native {

DesktopPresenceRuntime::DesktopPresenceRuntime() {
  std::ostringstream id;
  id << "native-" << GetCurrentProcessId() << '-'
     << GetTickCount64();
  boot_id_ = id.str();
}

double DesktopPresenceRuntime::NowMilliseconds() {
  return std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
}

bool DesktopPresenceRuntime::IsInputBlocked() {
  HDESK desktop = OpenInputDesktop(
      0, FALSE, DESKTOP_SWITCHDESKTOP | DESKTOP_READOBJECTS);
  if (!desktop) {
    return true;
  }
  wchar_t name[64]{};
  DWORD length = 0;
  const bool named = GetUserObjectInformationW(
      desktop, UOI_NAME, name, sizeof(name), &length) != FALSE;
  CloseDesktop(desktop);
  return named && std::wstring_view(name) != L"Default";
}

ag99::runtime::Json DesktopPresenceRuntime::Snapshot(
    const State& state,
    double now_ms,
    std::string_view status) const {
  ag99::runtime::Json returned = nullptr;
  if (state.returned) {
    returned = {
        {"event_id", state.returned->event_id},
        {"basis", state.returned->basis},
        {"inactive_seconds", state.returned->inactive_seconds},
        {"age_seconds", std::max(
            0.0, (now_ms - state.returned->at_ms) / 1000.0)}};
  }
  return {
      {"boot_id", boot_id_},
      {"sequence", state.sequence},
      {"state", status},
      {"returned", std::move(returned)},
  };
}

std::optional<ag99::runtime::Json> DesktopPresenceRuntime::Read(
    const ag99::runtime::DesktopPresenceRequest& request,
    std::string& error) {
  std::scoped_lock lock(mutex_);
  auto& state = states_[request.monitor_id];
  const auto identity = request.monitor_id + ":"
      + std::to_string(request.idle_after_seconds) + ":"
      + std::to_string(request.minimum_away_seconds) + ":"
      + std::to_string(request.confirmation_seconds);
  if (state.identity != identity) {
    state.identity = identity;
    state.idle_after_seconds = request.idle_after_seconds;
    state.minimum_away_seconds = request.minimum_away_seconds;
    state.confirmation_seconds = request.confirmation_seconds;
    state.initialized = false;
    state.armed = false;
    state.previous_input_ms = -INFINITY;
    state.away.reset();
    state.candidate.reset();
    state.returned.reset();
  }

  LASTINPUTINFO input{};
  input.cbSize = sizeof(input);
  if (!GetLastInputInfo(&input)) {
    error = "desktop_presence_input_unavailable";
    state.initialized = false;
    state.armed = false;
    state.away.reset();
    state.candidate.reset();
    return std::nullopt;
  }
  const auto now_ms = NowMilliseconds();
  const auto tick_now = static_cast<DWORD>(GetTickCount64());
  const auto input_tick = input.dwTime;
  const auto idle_ms = static_cast<double>(
      static_cast<DWORD>(tick_now - input_tick));
  const auto idle_seconds = idle_ms / 1000.0;
  const bool blocked = IsInputBlocked();
  const auto input_at_ms = now_ms - idle_ms;

  if (!state.initialized) {
    state.initialized = true;
    state.previous_input_ms = input_at_ms;
    state.armed = !blocked && idle_seconds <= 2.0;
    if (blocked || idle_seconds >= state.idle_after_seconds) {
      state.away = State::Away{
          blocked ? "unlock" : "input_resumed",
          now_ms,
          false};
    }
    return Snapshot(
        state,
        now_ms,
        blocked || state.away ? "inactive" : "active");
  }

  if (blocked) {
    if (!state.away || state.away->basis == "input_resumed") {
      state.away = State::Away{"unlock", now_ms, true};
    }
    state.candidate.reset();
    return Snapshot(state, now_ms, "inactive");
  }
  if (!state.away && idle_seconds >= state.idle_after_seconds) {
    state.away = State::Away{
        "input_resumed", input_at_ms, state.armed};
  }
  if (state.away) {
    if (!state.candidate && idle_seconds <= 2.0) {
      const auto duration = std::max(
          0.0, (now_ms - state.away->since_ms) / 1000.0);
      const auto minimum = state.away->basis == "input_resumed"
          ? static_cast<double>(state.idle_after_seconds)
          : static_cast<double>(state.minimum_away_seconds);
      if (!state.away->eligible || duration < minimum) {
        state.away.reset();
        state.armed = true;
      } else {
        state.candidate = State::Candidate{
            now_ms,
            input_at_ms,
            static_cast<int>(std::floor(duration))};
      }
    }
    if (state.candidate && state.away) {
      if (now_ms - state.candidate->since_ms > 15000.0) {
        state.away.reset();
        state.candidate.reset();
        state.armed = true;
      } else if (
          now_ms - state.candidate->since_ms
              >= state.confirmation_seconds * 1000.0
          && input_at_ms - state.candidate->input_at_ms >= 1500.0
          && idle_seconds <= 2.0) {
        ++state.sequence;
        state.returned = State::Returned{
            boot_id_ + ":" + std::to_string(state.sequence),
            state.away->basis,
            state.candidate->inactive_seconds,
            now_ms};
        state.away.reset();
        state.candidate.reset();
        state.armed = true;
      }
    }
  } else if (input_at_ms - state.previous_input_ms >= 1500.0) {
    state.armed = true;
  }
  state.previous_input_ms = std::max(state.previous_input_ms, input_at_ms);
  return Snapshot(
      state,
      now_ms,
      state.candidate ? "confirming" : state.away ? "inactive" : "active");
}

}  // namespace ag99::native
