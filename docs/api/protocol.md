# AG99live Protocol Contract

This document defines the current AG99live WebSocket protocol.

It only describes the active external protocol between frontend and backend.

## Envelope

All messages use the V2 envelope:

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
| --- | --- | --- | --- | --- |
| `message_id` | Segment | Protocol | Binds one assistant segment | Required on segment-bearing assistant outputs and `engine.motion_intent` |
| `turn_id` | Turn lifecycle | Backend | Connects `turn_started` / `synth_finished` / `turn_finished` / `interrupt` | Required on turn-scoped messages |
| `orchestration_id` | Playback group | Frontend | Preferred frontend session key | Present when available |

Frontend session resolution order:

```text
orch:<orchestration_id>
turn:<turn_id>
```

`message_id` is a segment key for:

- `output.text`
- `output.audio`
- `engine.motion_intent`

It is not a segment key for:

- `output.image`
- `output.transcription`
- most `control.*`
- most `system.*`

## Completion Signals

```text
control.synth_finished
= backend output queue closed
= no more output.* or engine.motion_intent segments for this turn

control.playback_finished
= frontend local playback settled
= synth_finished received and all segments locally settled

control.turn_finished
= backend turn closed
= emitted after backend receives playback_finished
```

## Message Types

### input.* (Frontend -> Backend)

| Type | Payload |
| --- | --- |
| `input.text` | `{ text: string, images: ImagePayload[] }` |
| `input.raw_audio_data` | `{ audio: number[], sample_rate: number, channels: 1 }` |
| `input.mic_audio_end` | `{ reason: string, dropped?: boolean }` |

Microphone input rules:

- One capture segment uses one fresh `input:*` `orchestration_id`.
- All raw audio chunks and the final `input.mic_audio_end` of that capture segment share the same `orchestration_id`.
- Backend STT ingress uses that `orchestration_id` as the buffer key.
- If `dropped === true`, backend discards the segment and does not transcribe it.

### output.* (Backend -> Frontend)

| Type | Payload | `message_id` required |
| --- | --- | --- |
| `output.text` | `{ text: string, speaker_name: string, avatar: string }` | yes |
| `output.audio` | `{ text: string, audio_url: string \| null, speaker_name: string, avatar: string }` | yes |
| `output.image` | `{ images: string[] }` | no |
| `output.transcription` | `{ text: string }` | no |

### control.* (Bidirectional)

| Type | Direction | Payload |
| --- | --- | --- |
| `control.turn_started` | Backend -> Frontend | `{}` |
| `control.synth_finished` | Backend -> Frontend | `{}` |
| `control.playback_finished` | Frontend -> Backend | `{ success: boolean, reason?: string }` |
| `control.turn_finished` | Backend -> Frontend | `{ success: boolean, reason?: string }` |
| `control.interrupt` | Bidirectional | `{}` |
| `control.start_mic` | Backend -> Frontend | `{}` |
| `control.error` | Backend -> Frontend | `{ message: string }` |

### system.* (Bidirectional)

| Type | Direction | Purpose |
| --- | --- | --- |
| `system.server_info` | Backend -> Frontend | Connection info and runtime flags |
| `system.model_sync` | Backend -> Frontend | Model capability sync |
| `system.semantic_axis_profile_saved` | Backend -> Frontend | Profile save confirmation |
| `system.semantic_axis_profile_save` | Frontend -> Backend | Profile save request |
| `system.semantic_axis_profile_save_failed` | Backend -> Frontend | Profile save failure |
| `system.history_*` | Bidirectional | History CRUD |
| `system.motion_tuning_sample_*` | Bidirectional | Motion tuning sample CRUD |

### engine.* (Bidirectional)

| Type | Direction | Schema |
| --- | --- | --- |
| `engine.motion_intent` | Bidirectional | `engine.motion_intent.v2` |

## Motion Path

Current external motion protocol path:

```text
backend emits engine.motion_intent
-> frontend normalizes intent
-> frontend ModelEngine compiles intent to engine.parameter_plan.v2 locally
-> frontend runtime executes the plan
```

The backend main path broadcasts `engine.motion_intent` only.

If a backend runtime-internal fallback is explicitly invoked, its result must still return to the same `engine.motion_intent` path and the same segment identity.

## Schema Versions

### External protocol schemas

| Schema | Status | Purpose |
| --- | --- | --- |
| `engine.motion_intent.v2` | active | Backend-to-frontend semantic motion payload |
| `ag99.semantic_axis_profile.v1` | active | Canonical semantic axis profile |
| `live2d_runtime_cache.v1` | active | Backend Live2D scan cache |

### Frontend internal execution schema

| Schema | Status | Purpose |
| --- | --- | --- |
| `engine.parameter_plan.v2` | active | Frontend ModelEngine compiled execution plan |

`engine.parameter_plan.v2` is an internal frontend execution schema. It is not an active adapter preview ingress type.

## Implementation Files

| Side | Location |
| --- | --- |
| Backend constants | `astrbot_plugin_ag99live_adapter/protocol/constants.py` |
| Backend parser | `astrbot_plugin_ag99live_adapter/protocol/parser.py` |
| Frontend types | `frontend/src/types/protocol.ts` |
| Frontend message types | `frontend/src/adapter-connection/core/protocolMessageTypes.ts` |
| Frontend inbound mapping | `frontend/src/adapter-connection/inbound/inboundEvents.ts` |

## Mutation Rules

- Add or remove protocol message types on both frontend and backend together.
- Update schema validation together with contract updates.
- Do not describe internal frontend execution schemas as external protocol message types unless they are actually accepted by the adapter boundary.
