# Architecture Documentation

Documents system architecture, boundaries, layers, and long-term structural decisions.

## Core Architecture Docs

- `项目结构与模块职责总览.md` - Long-lived repo structure and module responsibility index
- `前端适配器拆分与优化方案.md` - Adapter split and optimization plan for data/runtime/facade boundaries
- `当前前后端动作链路结构说明.md` - Text/audio/motion pipeline from user input to turn completion
- `前端系统模块架构说明.md` - Frontend module boundaries, dependency direction, consolidation priorities
- `文本语音动作同步播放编排设计.md` - Soft-sync startup strategy for text/audio/motion
- `../ModelEngine驱动系统边界与分层设计.md` - Current frontend ModelEngine boundary and modular layering plan

## Key Concepts

- **TurnPlaybackSession** → Frontend playback truth source, one per turn, contains multiple segments
- **Three-signal completion** → `synth_finished` (queue closed) → `playback_finished` (local settled) → `turn_finished` (backend confirmed)
- **ModelEngine** → Compiles `engine.motion_intent.v2` into `engine.parameter_plan.v2`; current next focus is its internal boundary review
- **AdapterProtocol** → V2 WebSocket, envelope validation at boundary, session-aware context; first-round split is clear enough for engine work

## Related

- `docs/api/protocol.md` - Protocol contract (message types, ID contract, schemas)
- `docs/design/engineering_cybernetics_alignment.md` - VEC governance philosophy
- `docs/项目结构优化路线图.md` - Structure optimization roadmap
- `docs/后端主导数据边界与执行计划.md` - Long-term data ownership boundaries
