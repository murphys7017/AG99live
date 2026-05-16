# 项目总览与模块职责

本文是 AG99live 的长期维护型结构总览文档，合并了仓库结构、模块职责、依赖方向和维护规则。

目标：稳定回答下面这些问题：

1. 这个项目当前有哪些一级目录和一级模块
2. 每个模块负责什么，不负责什么
3. 模块之间的大致依赖方向是什么
4. 后续重构时，应该优先把变更落在哪个模块

## 1. 项目定位

AG99live 是一个**桌面虚拟宠物（桌宠）实时交互系统**，由前端 Electron 桌面应用 + 后端 AstrBot 插件适配器组成，通过 WebSocket 协议通信。

核心数据流：

```
用户输入（文本/语音）
  → 前端 Electron 应用
    → WebSocket 发送到后端
      → AstrBot 适配器协调 AI 模型
        → 返回文本回复 + 音频 + 动作指令
          → 前端播放：文字显示 + 音频播放 + Live2D 模型动作渲染
```

## 2. 仓库目录结构

```text
AG99live/
  .ai/                          # AI 代理治理入口和状态文件
  analysis/                     # 分析材料、实验或临时研究产物
  astrbot_plugin_ag99live_adapter/  # 后端 AstrBot 适配器、运行时、协议和动作服务
  docs/                         # 架构、协议、设计文档
  frontend/                     # Electron + Vue 前端桌宠运行时和工具窗口
  tools/                        # 仓库级开发辅助脚本和校验工具
```

## 3. 系统总体分块

从职责上看，项目分为四个大系统：

```text
前端桌宠运行时
后端适配器与服务
动作与模型能力体系
文档与治理体系
```

更贴近数据流的表达：

```text
用户 / 辅助窗口
  → 前端运行时
    → 后端适配器
      → 模型与动作服务
        → 前端回放与渲染
```

## 4. 前端架构

前端位于 `frontend/`，是桌宠系统的运行时 owner。当前建议理解为 **8 个一级模块 + 2 个横切层**。

### 4.1 模块总览

```text
Desktop Host           → Electron 桌面宿主
Runtime Bridge         → 多窗口 snapshot/command 同步
Pet Runtime Controller → 主窗口组合根（composition root）
Adapter Protocol       → WebSocket 协议收发与边界校验
Turn Playback Pipeline → 文本/音频/动作播放轮次编排
Model Capability       → 模型能力事实维护
Motion Engine          → 动作意图编译与参数计划生成
Avatar Runtime         → Live2D 渲染与参数执行
Authoring Tools        → 设置/历史/动作实验室/Profile 编辑

Audio IO      (横切)   → 音频播放与麦克风输入
Contracts     (横切)   → 前后端协议与窗口间通信契约
```

模块关系：

```text
Desktop Host
  → Runtime Bridge
      → Pet Runtime Controller
          → Adapter Protocol
          → Turn Playback Pipeline
          → Model Capability
          → Motion Engine
          → Avatar Runtime
          → Authoring Tools projection
```

数据方向：

```text
Adapter Protocol → Turn Playback Pipeline → Motion Engine → Avatar Runtime
Model Capability → Motion Engine
Model Capability → Authoring Tools
Pet Runtime Controller → Runtime Bridge → Authoring Tools
```

### 4.2 Desktop Host

**位置**：`frontend/electron/main/`、`frontend/electron/preload/`

**职责**：
- 创建宠物窗口、overlay、设置、历史、Action Lab、Profile Editor
- 管理透明窗口、鼠标穿透、窗口拖动
- 提供右键菜单和桌面截图
- 暴露 preload API：`window.ag99desktop`

**边界要求**：
- 不理解 Adapter V2 协议
- 不理解 `TurnPlaybackSession`
- 不直接参与动作编译和 Live2D 参数计划

### 4.3 Runtime Bridge

**位置**：`frontend/src/composables/useDesktopBridge.ts`、`frontend/src/composables/usePetRuntimeSnapshotPublisher.ts`、`frontend/src/desktop-bridge/`、`frontend/src/types/desktop.ts`

**职责**：
- 主宠物窗口发布 `DesktopRuntimeSnapshot` 和 `DesktopModelProjectionSnapshot`
- 辅助窗口发送 `DesktopRuntimeCommand`
- Profile Editor 使用独立的 profile authoring command/snapshot
- 使用 `BroadcastChannel` 实时同步，`localStorage` 兜底恢复

**边界要求**：
- 辅助窗口不直接持有 Adapter WebSocket
- 辅助窗口不直接修改 Turn Pipeline 内部状态
- 主窗口负责解释 command 并调用对应运行时模块

### 4.4 Pet Runtime Controller（Composition Root）

**位置**：`frontend/src/composables/usePetDesktopController.ts`、`frontend/src/views/PetDesktopView.vue`

**职责**：
- 装配所有核心模块：Adapter、Session Store、Orchestrator、Completion Coordinator、Model Engine、Motion Player、Desktop Bridge、Snapshot Publisher
- 处理辅助窗口 command 和 Profile Editor command
- 计算 `connectionState`、`connectionLabel`、`stageMessage`、`aiState`
- 触发自动连接 Adapter 和 PTT（Push-to-Talk）监听

**边界要求**：
- 可以装配模块，但不应发明新的播放语义
- 可以转发命令，但不应把具体协议处理写在自己内部

### 4.5 Adapter Protocol

**位置**：`frontend/src/composables/useAdapterConnection.ts`、`frontend/src/adapter-connection/`

**子目录结构**：

```text
adapter-connection/
  core/        → transport、envelope、address、preferences、protocol constants
  inbound/     → envelope 校验、event mapping、domain dispatcher
  outbound/    → AdapterOutboundClient、outbound actions
  runtime/     → audio、microphone、release queue、connection reset
  features/    → history、motion tuning、model sync payload normalization
```

**入站流程**：

```text
WebSocket raw message
  → parseInboundEnvelope
    → mapInboundEnvelopeToEvent
      → dispatchInboundEvent
        → session / model / audio / history / motion tuning 状态写入
```

**出站流程**：

```text
runtime action
  → buildMessageEnvelope
    → WebSocket send
```

**常见出站协议**：`input.text`、`control.interrupt`、`control.playback_finished`、`system.history_*`、`system.semantic_axis_profile_save`、`system.motion_tuning_sample_*`、`engine.motion_intent` preview

**边界要求**：
- 协议 envelope 和 payload 校验应在这一层完成
- 进入运行时的事件应尽量是已经定型的内部事件
- Adapter 层不应该直接包含动作编译逻辑

### 4.6 Turn Playback Pipeline

**位置**：`frontend/src/turn-playback/`、`frontend/src/composables/useTurnPlaybackSessionStore.ts`、`frontend/src/composables/useTurnPlaybackOrchestrator.ts`、`frontend/src/composables/turnPlaybackOrchestratorCore.ts`、`frontend/src/composables/usePlaybackCompletionCoordinator.ts`

**核心对象**：

```text
TurnPlaybackSession
  → backend / phase / interrupted
  → segments: Map<messageId, TurnPlaybackSegment>
       → text / audio / motion
```

**建模原则**：

```text
一个 user input
  → 一个 TurnPlaybackSession
    → 多个 TurnPlaybackSegment
      → 每个 segment = text + audio + motion
```

**ID 契约**：

| ID | 归属层级 | 作用 | 缺失时策略 |
|---|---|---|---|
| `orchestration_id` | 播放编排层 | 优先 session 聚合 ID | 缺失时退到 `turn_id` |
| `turn_id` | 后端 turn 生命周期 | 连接后端 turn_started/finished/interrupt | 缺失时不再匿名创建 session |
| `message_id` | 单条回复 segment | 绑定同一片段的 text/audio/motion | 新协议路径必须携带，缺失时作为协议错误 |

**Session key 解析顺序**：`orch:<orchestration_id>` → `turn:<turn_id>`

**起播策略常量**：
- `AUDIO_MOTION_SYNC_WAIT_MS = 820` — 等待晚到动作加入同轮起播
- `TEXT_ONLY_RELEASE_WAIT_MS = 260` — 避免纯文本回复被过度延迟

**完成语义（三层信号）**：

```text
control.synth_finished    = 后端输出队列关闭，不会再追加 segment
control.playback_finished = 前端本地播放完成（synth_finished 已到 + 所有 segment settled）
control.turn_finished     = 后端确认整轮闭环收口
```

**边界要求**：
- Pipeline 不应该理解 WebSocket 原始消息
- Pipeline 不应该编译动作
- Pipeline 只应该通过窄接口通知 Adapter 发送 `playback_finished`

### 4.7 Model Capability

**位置**：`frontend/src/composables/useModelSync.ts`、`frontend/src/types/protocol.ts`、`frontend/src/action-lab/parameterActionPreview.ts`

**职责**：维护后端同步来的模型能力事实，包括：
- 当前 session/conf 信息、选中模型、可用模型列表
- resource scan、parameter scan、expression scan
- motion resource pool、base/parameter action library
- semantic axis profile、calibration profile
- runtime cache errors

**边界要求**：
- 是模型能力事实来源
- Motion Engine 和 Authoring Tools 消费它
- 不负责播放编排

### 4.8 Motion Engine

**位置**：`frontend/src/model-engine/`

**当前文件**：

| 文件 | 职责 |
|---|---|
| `useModelEngine.ts` | 引擎 facade/runtime：排队、等待音频、编译、播放、状态 |
| `compiler.ts` | intent → plan 编译核心 |
| `normalize.ts` | `motion_intent.v2` 和 `parameter_plan.v2` 入站归一化 |
| `planParser.ts` | `parameter_plan.v2` parser/clone |
| `timing.ts` | timing resolution（hint/audio_sync/default） |
| `settings.ts` | 强度倍率设置 |
| `contracts.ts` | 引擎类型和依赖端口 |
| `constants.ts` | 默认时长、等待窗口、参数轴常量 |

**输入**：`engine.motion_intent.v2`、`engine.parameter_plan.v2`、当前 `ModelSummary`、当前 `SemanticAxisProfile`、motion engine settings、音频播放上下文

**输出**：编译后的 `engine.parameter_plan.v2`、`motionPlayer.playPlan(...)`、motion playback record

**边界要求**：
- 不直接处理 WebSocket
- 不直接决定文本和音频何时释放
- 可读取必要的 session/audio timing 信息，但不应成为 Turn Pipeline 的事实来源

### 4.9 Avatar Runtime

**位置**：`frontend/src/components/DesktopPetCanvas.vue`、`frontend/src/composables/useLive2dRenderer.ts`、`frontend/src/composables/usePreviewMotionPlayer.ts`、`frontend/src/live2d/WebSDK/`

**职责**：
- 初始化 Cubism SDK、加载模型和纹理
- 渲染透明桌宠 canvas
- 执行动作参数计划
- 支持 soft handoff
- 处理 ambient/idle motion

**边界要求**：
- 不理解后端协议
- 不理解 Turn Playback Session
- 只接受模型加载和参数计划执行请求

### 4.10 Authoring Tools

**位置**：`frontend/src/views/SettingsWindowView.vue`、`frontend/src/views/HistoryWindowView.vue`、`frontend/src/views/ActionLabWindowView.vue`、`frontend/src/views/ProfileEditorWindowView.vue`、`frontend/src/components/MotionTuningPanel.vue`、`frontend/src/components/SemanticAxisProfileEditor.vue`、`frontend/src/components/BaseActionPreviewPanel.vue`

**交互模式**：

```text
工具窗口
  → useDesktopBridge.sendCommand(...)
    → Pet Runtime Controller
      → 对应 runtime 模块
        → snapshot 回传工具窗口
```

**边界要求**：
- 工具窗口不直接连接 Adapter
- 工具窗口不直接写主运行时状态
- 工具窗口通过 command 表达意图，通过 snapshot 展示结果

### 4.11 Audio IO（横切层）

**位置**：`frontend/src/adapter-connection/runtime/audioRuntime.ts`、`frontend/src/adapter-connection/runtime/audioPlayback.ts`、`frontend/src/adapter-connection/runtime/microphoneRuntime.ts`、`frontend/src/adapter-connection/runtime/microphoneCapture.ts`、`frontend/src/adapter-connection/runtime/microphoneDevices.ts`

**输出音频方向**：

```text
output.audio → queue audio → release audio → start local playback
  → markAudioStarted / markAudioTerminal → Completion Coordinator
```

**输入麦克风方向**：

```text
microphone capture → allocate active mic input segment identity
  → input.raw_audio_data → input.mic_audio_end
```

**关键语义**：
- 一段采集期内的所有 `input.raw_audio_data` 与 `input.mic_audio_end` 共用同一个新的 `input:*` orchestration id
- 不再借用当前 assistant playback 的 `orchestration_id`
- 如果发送缓冲积压，前端标记为 broken，`input.mic_audio_end` 带 `dropped: true`
- 后端收到 `dropped: true` 后直接清空音频缓冲，不做残缺转写

### 4.12 Contracts（横切层）

**位置**：`frontend/src/types/protocol.ts`、`frontend/src/types/desktop.ts`、`frontend/src/types/semantic-axis-profile.ts`、`frontend/src/adapter-connection/core/protocolMessageTypes.ts`、`frontend/src/adapter-connection/inbound/inboundPayloads.ts`

**包括**：Adapter V2 envelope、message types、motion schemas、model sync payload、desktop runtime command/snapshot、profile authoring command/snapshot、semantic axis profile

## 5. 后端架构

后端核心位于 `astrbot_plugin_ag99live_adapter/`，是前端桌宠运行时的协作编排后端。

### 5.1 目录结构

| 路径 | 职责 |
|---|---|
| `runtime/` | turn 状态机、主运行时编排、协议收口 |
| `protocol/` | 协议消息定义、解析、构建 |
| `transport/` | WebSocket 服务器和静态资源路由 |
| `services/` | 上层服务组合（speech、media、history、frontend system） |
| `motion/` | 动作处理（inline motion、realtime motion plan、output sanitizer、action LLM filter） |
| `middleware/` | 中间处理层（interaction motion contributors） |
| `prompts/` | 提示词和模型交互文本资源 |
| `live2d/` | Live2D 相关（semantic axis profile、scanner、runtime cache） |
| `assets/` | 静态资源 |
| `tests/` | 测试 |

### 5.2 核心模块

**`runtime/turn_coordinator.py`** — 后端协议和轮次编排中枢：
- 接收入站协议、建立 turn
- 广播 `output.text / output.audio / engine.motion_intent`
- 在音频轮次下等待前端 `control.playback_finished`
- 收到后发送 `control.turn_finished`

**`runtime/session_state.py`** — 后端单连接 turn 状态机：
- 管理 `current_turn_id`、`current_orchestration_id`
- 区分阶段：idle → thinking → synthesizing → playing
- 在有音频时等待前端 `playback_finished`

**`protocol/`** — 协议层：
- `constants.py` — 协议消息类型常量
- `parser.py` — 入站消息解析
- `builder.py` — 出站消息构建
- `models.py` — 协议数据模型

**`services/`** — 服务层：
- `speech_service.py` — 语音输入处理（STT ingress）
- `media_service.py` — 音频文件缓存与服务
- `history_service.py` — 历史 CRUD
- `frontend_system_service.py` — 前端系统消息处理
- `message_factory.py` — 消息工厂

**`motion/`** — 动作处理：
- `inline_motion.py` — 内联动作提取与验证
- `realtime_motion_plan.py` — 实时动作计划
- `output_sanitizer.py` — 输出文本清理
- `action_llm_filter.py` — LLM 动作过滤

### 5.3 后端职责总结

后端承担：
- 维护 turn 生命周期
- 接收前端 `input.*`
- 广播 `output.* / control.* / engine.*`
- 同步模型能力和 profile
- 提供动作调参样本存储与读取
- 语音输入处理（STT）
- 音频文件缓存与 HTTP 服务

## 6. 关键主流程

### 6.1 文本对话主流程

```text
辅助窗口输入文本
  → DesktopRuntimeCommand: send_text
    → usePetDesktopController
      → adapter.sendText
        → input.text → 后端
          → control.turn_started
            → output.text / output.audio / engine.motion_*
              → useAdapterConnection dispatch
                → TurnPlaybackSessionStore
                  → useTurnPlaybackOrchestrator release
                    → text display / audio playback / motion engine
                      → control.synth_finished closes segment queue
                        → all segments locally settled
                          → control.playback_finished
                            → control.turn_finished
                              → session completed
```

### 6.2 模型同步主流程

```text
后端扫描模型
  → system.model_sync
    → useAdapterConnection
      → useModelSync
        → selectedModel / selectedSemanticAxisProfile
          → Motion Engine / Authoring Tools / Runtime Snapshot
```

### 6.3 动作测试主流程

```text
Action Lab / Profile Editor
  → preview_motion_payload
    → usePetDesktopController
      → modelEngine.playPreviewPayload 本地播放
        → adapter.sendMotionPayloadPreview 发给后端记录或验证
```

## 7. 推荐依赖方向

后续维护时坚持以下方向：

```text
Authoring Tools → Runtime Bridge → Pet Runtime Controller

Pet Runtime Controller → Adapter Protocol
Pet Runtime Controller → Turn Playback Pipeline
Pet Runtime Controller → Model Capability
Pet Runtime Controller → Motion Engine
Pet Runtime Controller → Avatar Runtime

Adapter Protocol → Turn Playback Pipeline
Turn Playback Pipeline → Motion Engine
Motion Engine → Avatar Runtime
Model Capability → Motion Engine
Model Capability → Authoring Tools
Turn Playback Pipeline → Adapter Protocol (playback_finished only, via narrow port)
```

**不建议出现**：
- Avatar Runtime 直接访问 Adapter Protocol
- Authoring Tools 直接修改 Turn Playback Session
- Motion Engine 直接发送 WebSocket 消息
- Adapter Protocol 内部编译动作计划
- Desktop Host 理解业务协议

## 8. 当前判断与维护规则

### 8.1 关键判断

1. 前端已经不是普通页面应用，而是**桌面运行时系统**
2. `usePetDesktopController.ts` 是前端主装配根
3. `adapter-connection/` 是适配器核心实现区，已拆为 `core/inbound/outbound/runtime/features`
4. 适配器已完成第一轮外部边界收口
5. `model-engine/` 已经是动作引擎独立区域
6. `action-lab/` 与相关组件是动作库/调参工具区，当前可暂缓调整
7. `astrbot_plugin_ag99live_adapter/` 是后端主业务区，不只是简单桥接壳

### 8.2 维护规则

1. 只写"当前真实结构"，不要把未来设想伪装成现状
2. 每当新增一级模块或一级职责，就补到本文
3. 每当一个模块职责明显变化，就更新"负责什么 / 不负责什么"
4. 每当重构完成一个大边界，就同步删掉过期描述
5. 如果某个文档更偏时序或实现细节，就写到其他架构文档，不要把本文写成大杂烩

## 9. 相关文档

- [WebSocket 协议契约](./02-protocol.md)
- [前后端动作链路结构](./03-playback-linkage.md)
- [播放同步编排设计](./04-playback-orchestration.md)
- [ModelEngine 边界与分层设计](../02-design/01-model-engine-boundary.md)
