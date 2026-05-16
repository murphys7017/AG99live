# AG99live Protocol Contract

This is the single source of truth for the AG99live WebSocket protocol.
Frontend and backend must align with this contract.

## Envelope

All messages follow the V2 envelope:

```json
{
  "type": "<message_type>",
  "version": "v2",
  "message_id": "<non-empty string>",
  "session_id": "<string>",
  "turn_id": "<string | null>",
  "orchestration_id": "<string | null>",
  "source": "adapter" | "frontend" | "astrbot" | "engine",
  "timestamp": "<ISO 8601>",
  "payload": { ... }
}
```

## ID Contract

| ID | Level | Owner | Purpose | Required |
|---|---|---|---|---|
| `message_id` | Segment | Protocol | Binds text/audio/motion for one assistant segment | Envelope field is present on current protocol messages; semantically required on segment-bearing assistant outputs and `engine.motion_*` |
| `turn_id` | Turn lifecycle | Backend | Connects turn_started / synth_finished / turn_finished / interrupt | On all turn-scoped messages |
| `orchestration_id` | Playback group | Frontend | Groups segments among the same playback session; preferred session key | When available |

### Resolution order (frontend)

```
orch:<orchestration_id>  →  preferred
turn:<turn_id>          →  fallback when orchestration_id missing
```

When a turn-first session later receives an `orchestration_id`, the session promotes from `turn:<id>` to `orch:<id>` — no duplicate sessions.

`message_id` needs one more distinction:

- current backend/frontend envelopes still carry a `message_id` field broadly
- frontend segment playback logic only treats it as a required segment key for:
  - `output.text`
  - `output.audio`
  - `engine.motion_intent`
  - `engine.parameter_plan`
- messages such as `output.image`, `output.transcription`, most `control.*`, and most `system.*` do not use `message_id` for segment binding

## Completion Signal Semantics

```
┌─────────────────────────────────────────────┐
│ control.synth_finished                       │
│ Backend → Frontend                           │
│ "Output queue closed."                       │
│ No more output.* / engine.motion_* segments. │
│ NOT single-audio-done. NOT turn-done.        │
├─────────────────────────────────────────────┤
│ control.playback_finished                    │
│ Frontend → Backend                           │
│ "Local playback settled."                    │
│ Requires: synth_finished received +          │
│           all segments locally settled.       │
├─────────────────────────────────────────────┤
│ control.turn_finished                        │
│ Backend → Frontend                           │
│ "Turn closed."                               │
│ Backend confirms after playback_finished.    │
│ Carries success + optional reason.           │
└─────────────────────────────────────────────┘
```

The backend must send `synth_finished` AFTER the last segment of the turn.
The backend sends `turn_finished` only AFTER receiving `playback_finished`.

## Message Types

### input.* (Frontend → Backend)

| Type | Payload |
|---|---|
| `input.text` | `{ text: string, images: ImagePayload[] }` |
| `input.raw_audio_data` | `{ audio: number[], sample_rate: number, channels: 1 }` |
| `input.mic_audio_end` | `{ reason: string, dropped?: boolean }` |

Input audio segment rules:

- A single microphone capture segment uses one fresh `input:*` `orchestration_id`.
- All `input.raw_audio_data` chunks of that capture segment and its final `input.mic_audio_end` must carry the same `orchestration_id`.
- Backend STT ingress treats this input `orchestration_id` as the microphone segment buffer key.
- If `input.mic_audio_end.payload.dropped === true`, backend must discard that segment buffer and must not transcribe it.
- If microphone device switching ends one capture segment and starts another, frontend must close the old segment first, then start sending chunks for the new one.

### output.* (Backend → Frontend)

| Type | Payload | message_id required |
|---|---|---|
| `output.text` | `{ text: string, speaker_name: string, avatar: string }` | **yes** |
| `output.audio` | `{ text: string, audio_url: string | null, speaker_name: string, avatar: string }` | **yes** |
| `output.image` | `{ images: string[] }` | no |
| `output.transcription` | `{ text: string }` | no |

### control.* (Bidirectional)

| Type | Direction | Payload |
|---|---|---|
| `control.turn_started` | Backend → Frontend | `{}` |
| `control.synth_finished` | Backend → Frontend | `{}` |
| `control.playback_finished` | Frontend → Backend | `{ success: boolean, reason?: string }` |
| `control.turn_finished` | Backend → Frontend | `{ success: boolean, reason?: string }` |
| `control.interrupt` | Bidirectional | `{}` |
| `control.start_mic` | Backend → Frontend | `{}` |
| `control.error` | Backend → Frontend | `{ message: string }` |

Interrupt audio rule:

- If a segment audio has already been released for local playback, frontend interrupt handling must write that segment audio to a terminal state (`failed`) before clearing playback runtime state.

### system.* (Bidirectional)

| Type | Direction | Purpose |
|---|---|---|
| `system.server_info` | Backend → Frontend | Connection info, model list |
| `system.model_sync` | Backend → Frontend | Model capability sync |
| `system.semantic_axis_profile_saved` | Backend → Frontend | Profile save confirmation |
| `system.semantic_axis_profile_save` | Frontend → Backend | Profile save request |
| `system.semantic_axis_profile_save_failed` | Backend → Frontend | Profile save failure |
| `system.history_*` | Bidirectional | History CRUD |
| `system.motion_tuning_sample_*` | Bidirectional | Motion tuning sample CRUD |

### engine.* (Bidirectional)

| Type | Direction | Schema |
|---|---|---|
| `engine.motion_intent` | Bidirectional | `engine.motion_intent.v2` |
| `engine.parameter_plan` | Bidirectional | `engine.parameter_plan.v2` |

## Motion Generation Paths

Current backend motion broadcast on the main protocol path has two stable sources:

1. `inline_first`
   - The main chat model reply includes inline `<@anim {...}>`.
   - Backend extracts the nested `intent` and broadcasts `engine.motion_intent` directly.

2. Middleware structured motion objects
   - Interaction middleware returns motion payloads via `client_objects` / plugin hints.
   - Backend reads them from `platform_extras` and broadcasts them directly on the matching segment.

There is no longer any legacy plugin hook that schedules a second motion-only request after the main reply has completed.

`split_after_reply` now means:
- the main model only replies with text
- the preferred motion source is middleware `client_objects` / plugin hints
- if a runtime-internal fallback module is explicitly invoked, its result must still be emitted back onto the same `engine.motion_*` protocol path and segment identity

## Schema Versions

| Schema | Current | Purpose |
|---|---|---|
| `engine.motion_intent.v2` | active | Semantic axis intent from backend → frontend compiles to parameter_plan.v2 |
| `engine.parameter_plan.v2` | active | Frontend-compiled parameter plan executed by ModelEngine |
| `ag99.semantic_axis_profile.v1` | active | Canonical semantic axis profile stored by backend |
| `live2d_runtime_cache.v1` | active | Backend-side Live2D scan cache |

## Implementation Files

| Side | Location |
|---|---|
| Backend constants | `astrbot_plugin_ag99live_adapter/protocol/constants.py` |
| Backend parser | `astrbot_plugin_ag99live_adapter/protocol/parser.py` |
| Backend builder | `astrbot_plugin_ag99live_adapter/protocol/builder.py` |
| Frontend types | `frontend/src/types/protocol.ts` |
| Frontend message types | `frontend/src/adapter-connection/protocolMessageTypes.ts` |
| Frontend inbound mapping | `frontend/src/adapter-connection/inboundEvents.ts` |

## Mutation Rules

- Adding a new message type: add to both `constants.py` and `protocolMessageTypes.ts` simultaneously.
- Adding a new payload field: add to both `protocol/models.py` (or parser) and `types/protocol.ts`.
- Changing a schema version: update both sides and all validation functions.
- Removing a type: must be done in lockstep; test suites on both sides must pass.
