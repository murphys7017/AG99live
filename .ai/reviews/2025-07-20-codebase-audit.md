# AG99live 代码库审阅报告

> 审阅时间：2025-07-20
>
> 审阅范围：全代码库，重点覆盖 Live2D 表现层、前后端链路、语义参数生成链路，以及桌面桥接、Electron 主进程、音频链路、后端全局状态、Scanner 模块、Protocol Parser、测试体系等补遗模块。
>
> 审阅方法：源码阅读 + 设计文档对照，不涉及运行时 Profiling 或集成测试。
>
> **前置说明**：本报告仅记录本次审阅时发现的问题与建议；部分问题已在后续迭代中修复，具体以当前代码为准。

---

## 目录

1. [总体评估](#1-总体评估)
2. [Live2D 表现层](#2-live2d-表现层)
3. [前后端链路](#3-前后端链路)
4. [语义参数生成链路](#4-语义参数生成链路)
5. [桌面桥接层（Desktop Bridge）](#5-桌面桥接层desktop-bridge)
6. [Electron 主进程](#6-electron-主进程)
7. [音频链路](#7-音频链路)
8. [后端全局状态 RuntimeState](#8-后端全局状态-runtimestate)
9. [Live2D Scanner](#9-live2d-scanner)
10. [Protocol Parser](#10-protocol-parser)
11. [远程 Operator 子系统](#11-远程-operator-子系统)
12. [测试体系](#12-测试体系)
13. [全局优先级排布](#13-全局优先级排布)
14. [后续处理记录](#14-后续处理记录)

---

## 1. 总体评估

### 1.1 正面评价

- **架构设计质量高**：三层完成语义（synth_finished / playback_finished / turn_finished）、编译 Pipeline 职责分离（8个独立 Stage）、Fallback Pose 三级优先级体系，都显示了对复杂分布式系统问题的深入理解。
- **文档完备**：`docs/` 目录覆盖架构、协议、动作链路、Stage 设计、前端结构维护清单等多个维度，设计决策有明确记录和理由，远超一般项目水平。
- **前端模块按领域拆分**：adapter-connection、turn-playback、model-engine、desktop-bridge、live2d-renderer 按领域而非技术分层，维护意图清晰。
- **协议设计谨慎**：`message_id` 强制校验、`turn_id` 非空要求、flat axes v3 格式统一，入站/出站分隔清晰。
- **Fallback 体系完整**：三层来源（用户手调 > Expressions > AxisProfile bindings > neutral）定义明确，转换规则详细，最终输出与主链路同构。

### 1.2 核心风险

系统的主要风险集中在 **实现细节与精心设计的架构文档之间的落差**：

1. **少数关键实现使用"近似解"替代"确切解"**：`stableAxisDirection` 用字符串 hash 决定说话方向、`usePreviewMotionPlayer` 用 `setTimeout` 替代 SDK 完成回调、深层入站协议 parser 部分路径未全覆盖。
2. **部分大模块接近拆分临界点**：`turn_coordinator.py`（1004行）、`state.py`（约1282行）、`scan.py`（3010行）、`useAdapterConnection.ts`（622行）体量偏大。`state.py` 已先拆出 motion tuning store，但剩余扫描、配置和缓存职责仍需继续收口。
3. **跨窗口快照同步缺少时序保护**：BroadcastChannel + localStorage 组合没有 monotonic timestamp 或 revision，可能出现旧快照覆盖新快照。

---

## 2. Live2D 表现层

### 2.1 架构

```
useLive2dRenderer (Canvas/模型加载)
  → usePreviewMotionPlayer (参数计划播放器)
    → LAppAdapter.startDirectParameterPlan (Live2D SDK 写参)
```

### 2.2 发现问题

#### P0：`stableAxisDirection` 使用字符串 hash 决定方向，语义不可控

**文件**：`frontend/src/model-engine/compiler/stages/speechPoseStage.ts:171-175`

```ts
function stableAxisDirection(axisId: string): 1 | -1 {
  let hash = 0;
  for (let index = 0; index < axisId.length; index += 1) {
    hash = (hash + axisId.charCodeAt(index)) % 2;
  }
  return hash === 0 ? 1 : -1;
}
```

方向完全由 axis ID 的 charCode 奇偶性决定——`head_yaw` 可能偏左，`head_pitch` 可能偏上或偏下。这不仅影响 legacy speech pose，也影响 `voice_following` direct parameter channel 的正负选择。用户可能观察到角色说话时头身偏移方向不符合直觉。

**修复方向**（来自用户确认）：

1. 给 `voice_following_profile.channels` 增加显式 `direction` / signed amplitude / target_value 语义
2. 已知 channel 使用确定映射表
3. Legacy speech pose 改为基于 axis metadata 或配置
4. 保留兼容 fallback，但 fallback 要打 warning 方便发现未迁移模型

#### P1：动作完成依赖前端 timer 而非 SDK 完成事件

**文件**：`frontend/src/live2d-renderer/usePreviewMotionPlayer.ts:285`

```ts
scheduleTimer(runId, playbackPlan.totalDurationMs + 40, () => {
  state.status = "finished";
  // ...
});
```

`usePreviewMotionPlayer` 使用 `totalDurationMs + 40` 标记 finished。SDK adapter（`startDirectParameterPlan`）只返回 boolean，`LAppModel` 内部自己 stop，但没有把完成事件回传给前端。timer 作为唯一完成信号时，GPU 负载高或播放被中断的边界条件下可能误报完成。虽然有 `runId` 守卫（旧 timer 在 `activeRunId` 递增后不执行），但无法解决"播放实际偏慢但 timer 以为完成"的问题。

**修复方向**（来自用户确认）：

1. 让 `LAppModel.startDirectParameterPlan` 生成 `run_id`
2. 在 completed / stopped / rejected / failed 时经 `LAppAdapter` 回调或事件桥通知前端
3. `usePreviewMotionPlayer` 只把 timer 当 watchdog，不再当真实完成信号
4. 完成协调器按 `turnId + messageId + runId` 收口，不只靠全局 status

#### P2：DPR cap 1.25 硬编码，高 DPI 显示器上渲染模糊

**文件**：`frontend/src/live2d-renderer/useLive2dRenderer.ts:14`

```ts
const LIVE2D_RENDER_DPR_CAP = 1.25;
```

在现代 2x-3x 视网膜屏上，canvas 像素只有物理像素的 40-60%，Live2D 模型线条会明显模糊。这是一个已知的性能 vs 画质取舍，但没有暴露为用户可配置项。

**建议**：DPR cap 改为设置项（`ModelEngineSettings` 或独立配置），默认可继续保守。

#### P2：WebSDK 模块被 tsconfig 排除类型检查

`frontend/tsconfig.json` 的 exclude 列表包含 `src/live2d/WebSDK/**/*`。代码中使用 `@cubismsdksamples` Vite alias 动态导入 `initializeLive2D`、`updateModelConfig`、`LAppDelegate`。这意味着 SDK 升级或 API 变更时没有编译期保护。

**建议**：逐步为 adapter / model direct parameter plan 补声明和最小类型检查，先不一次性把整个 Live2D sample SDK 纳入严格 TS。

### 2.3 合规项

- ✅ `parseParameterPlan` 入口严格校验 `schema_version === SCHEMA_PARAMETER_PLAN_V2`
- ✅ `retimePlanForPlayback` 的 blend_in/blend_out 比例保持合理，最小 hold 120ms 防止零保持段
- ✅ Soft handoff 去重窗口（`PLAN_RESTART_DEDUP_WINDOW_MS = 700`）设计合理
- ✅ `SpeechPoseStage` 不覆盖已有 controlledValues 和 coupling，保持了 stage 间职责分离
- ✅ `VoiceFollowingProfile` channel 选择基于 Live2D 标准 channel，直接绑定 Live2D parameter

---

## 3. 前后端链路

### 3.1 主链路

```
① 前端 useAdapterConnection.sendText("用户输入")
  → WebSocket JSON: { type: "input.text", turn_id, payload }
② 后端 TurnCoordinator._commit_inbound_message
  → AstrBot Interaction Pipeline (LLM)
③ 后端 emit_message_chain
  → output.text / engine.motion_intent.v3 / output.audio / control.synth_finished
④ 前端 useTurnPlaybackSessionStore 按 turnId + messageId 写入 session
⑤ useTurnPlaybackOrchestrator 判断释放条件
⑥ useModelEngine.ingestInboundPayload → normalize → compile → play
⑦ usePlaybackCompletionCoordinator 判断本地完成 → control.playback_finished
⑧ 后端 finalize_turn → control.turn_finished
```

### 3.2 发现问题

#### P0：入站协议边界仍有部分深层透传路径

`parseInboundEnvelope()` 已做基础 envelope 校验，`inboundPayloads.ts` 已覆盖主要 payload。但：
- `system.model_sync.model_info` 只校验 object 后 cast，深层嵌套对象缺少逐层 parser
- `system.motion_tuning_samples_state` 的样本列表和 diagnostics 在 feature 内继续 normalize
- `window.postMessage` / devtools 的 `applyUnknownMessage` 入口可绕过正常 parser

**修复方向**（来自用户确认）：优先覆盖 `system.model_sync.model_info`、`runtime_cache_errors`、history payload、motion tuning state、devtools/window bridge。目标是所有入站边界先 parse 成可信结构，业务层不再接收 `unknown as Xxx`。

#### P1：useAdapterConnection.ts 门面偏大（622行）

集成连接生命周期、入站/出站分发、音频播放 runtime、麦克风 runtime、动作调参、历史记录、模型同步。文档 §3.1 要求收敛但无具体时间表。

**建议**：按 connection、inbound dispatch、audio runtime、microphone runtime、model sync facade 收窄门面。每拆一块保持协议和测试不变。

#### P1：TurnCoordinator 集中度偏高（1004行）

混合输入分发、事件提交、输出广播、动作 payload 转发、中断处理、播放完成生命周期。单个文件改动任一协议类型都触及此文件。

**建议**：按 input commit、output emit、motion broadcast、turn lifecycle 四块抽服务。每拆一块保持协议和测试不变。

#### P1：Session phase 状态迁移触发点分散

前端已有 `VALID_PHASE_TRANSITIONS`（`collecting → ready → playing → settling → completed`），晚到音频有 `settling → playing` 逻辑。但迁移的触发点分布在 orchestrator、completion coordinator、audio runtime、inbound dispatcher 多处。特别是动作完成仍监听全局 `motionPlayer.state.status`，多 segment / soft handoff 场景下归属需要更强测试保护。

**建议**：补充链路回归测试，重点覆盖 synth_finished 早于 audio、audio 晚到后 reopen、motion start 失败、soft handoff、多 segment 连续动作、stale playback_finished、interrupt 中断音频与动作等场景。

#### P2：音频 URL host 重写逻辑散布

前端可能把 `output.audio.audio_url` 的 host 重写为当前 WebSocket 可达 host。重写逻辑分布在 `audioPlayback.ts` 和 `adapterAudioBridge.ts` 之间，没有单一的标准化入口。WebSocket 重连后 host 变了但音频 URL 已启动播放时可能出现 404。

**建议**：集中到 `core/address.ts` 或独立 URL normalize 函数处理。

### 3.3 合规项

- ✅ 三层完成语义（synth_finished / playback_finished / turn_finished）设计深思熟虑，避免"整轮完成"的模糊判断
- ✅ WebSocket 协议使用 `max_size=16MB` 合理适应大帧场景
- ✅ 麦克风输入链路使用 `stream_id` 作为缓冲键，防止不同录音段串音
- ✅ PTT 的 keydown/keyup 使用独立 `turn_id` + `stream_id`，不借用当前 playback 的编排 ID
- ✅ `output.text/audio/motion` 已强制 `message_id`，缺失时返回 protocol_error

---

## 4. 语义参数生成链路

### 4.1 完整链路

```
LLM (AstrBot Interaction)
  → plugin_hints.ag99live_motion 或 <@anim {...}>
  → AG99liveMotionResultContributor normalize/repair
  → engine.motion_intent.v3 (flat axes)
  → Frontend normalizeMotionPayload
  → ModelEngine Compiler Pipeline:
     intentValidator → axisResolver → intensityStage → couplingStage
     → speechPoseStage → modeResolverStage → timingStage → planBuilder
  → engine.parameter_plan.v2
  → usePreviewMotionPlayer.startDirectParameterPlan
```

### 4.2 发现问题

#### P1：repair/fallback 承担过重，缺少命中率观测

`realtime_motion_plan.py` 中的 `_apply_expressive_floor_v2` 和 `fallback_pose.py`（726行）承担了大量修复工作，包括：轴值 clamp、轴数不足时补缺失骨架、duration 越界修复、嵌套格式拒绝等。

这是一个 **双保险体系**（prompt + repair/fallback），防守面完整，但问题在于防守层的命中率和原因**没有观测指标**，开发时看不到 LLM 输出质量是否在退化。

**建议**：在 `summary` 或模块级 counter 增加 fallback 原因统计，session 退出时打一条日志，例如：

```json
{
  "repair_stats": {
    "total_fallback": 17,
    "top_reasons": ["axes_empty:5", "duration_hint_wrong:4", "expression_axes_only:3", ...]
  }
}
```

#### P1：expressive vs idle 的区分存在模式漂移风险

- `axisResolverStage` 以 `MAX_SEMANTIC_AXIS_ERROR_RATE = 0.30` 容忍错误轴，但不会改变 `mode`
- `modeResolverStage` 的规则没有足够的测试保护
- `intensityStage` 在 `modeResolverStage` 之前执行，可能导致 intensity 影响 resolvedMode（文档 §5.2 已确认风险）

#### P2：语义轴数量膨胀影响 prompt token 成本

`SemanticAxisProfile` 可定义任意数量的 `primary`/`hint` 轴并被完整注入 LLM prompt。当模型有 30+ 轴时：
- prompt token 成本显著增加
- LLM 倾向于只改变少数轴，大量轴停留在 neutral
- 修复层难以判断"哪些中性轴是故意的，哪些是 LLM 遗漏的"

### 4.3 合规项

- ✅ Flat number `axes` 格式（v3）统一了协议和编译两端，v2 的 `{"value": number}` 嵌套被明确拒绝
- ✅ `choice` 字段从大模型输出中移除，去除了"生成 vs 选择"的二义性
- ✅ `idle` 明确不属于 LLM 输出职责，避免 LLM 在无情绪时输出零动作的 deadzone
- ✅ Compiler 8 个 stage 职责分明，每 stage 开头有 Reads/Writes/Does not own 注释
- ✅ `SpeechPoseStage` 将说话跟随从轴配置中分离，使用 `VoiceFollowingProfile` channel 体系
- ✅ fallback_pose_id 是 LLM 必填字段，确保至少有一个兜底姿态
- ✅ 三层 fallback 优先级规则定义明确，转换规则详细

---

## 5. 桌面桥接层（Desktop Bridge）

### 5.1 架构

```
主窗口 (PetDesktopView)
  → usePetRuntimeSnapshotPublisher
    → BroadcastChannel + localStorage: 快照/模型投影/动作调参
  → 辅助窗口 (History / Settings / ActionLab / ProfileEditor)
    → useDesktopBridge → 从 BroadcastChannel 读取快照
```

### 5.2 发现问题

#### P1：快照同步缺少时序保护

文档 §3.0 已确认："当前没有 snapshot revision、publisher id 或单调时间戳，多个窗口并发发布时可能旧快照覆盖新快照。"

具体场景：
1. 主窗口发布快照 A（ts=100）
2. 设置窗口干扰导致主窗口重新发布快照 B（ts=110）
3. 辅助窗口 BroadcastChannel 先后收到 A 和 B → 旧 A 在 localStorage 覆盖 B
4. 窗口刷新期间 BroadcastChannel 短暂断开，依赖 localStorage 恢复，可能拿到旧快照

**建议**：增加单调递增的时间戳或 revision 号，接收端按版本号决定是否覆盖。主窗口和发布者 ID 也需要包含以防冲突。

#### P1：快照深拷贝 + 跨窗口传输成本偏高

运行时快照包含完整模型投影、动作调参样本列表、播放 session 摘要等。每次快照变更触发 `cloneJson` 深拷贝 + BroadcastChannel 广播完整对象 + localStorage 序列化写入。

**建议**：减少快照字段、拆出大集合独立通道、只发布引用签名或摘要。具体可参考文档 §3.0 中已列出的优化方向。

#### P2：desktop-bridge/useDesktopBridge.ts 门面偏大（531行）

同时管理 Runtime 快照、Model Projection 快照、Profile Authoring 快照、Motion Tuning 样本、窗口状态、命令分发。虽然子模块已拆分（`snapshot/runtimeSnapshot.ts` 等），但 useDesktopBridge 作为总入口仍承担过多桥接。

### 5.3 合规项

- ✅ `snapshot.ts` 作为纯导出入口，具体归一化按类型拆分到子模块
- ✅ `useDesktopBridge` 使用 `safeNormalizeSnapshot` 防御性解析，不信任 localStorage 中可能被篡改的数据
- ✅ 组件不直接访问 `window.ag99desktop` 或 WebSocket，遵守了组件边界规则

---

## 6. Electron 主进程

### 6.1 文件组成

| 文件 | 行数 | 职责 |
|------|------|------|
| `electron/main/index.ts` | 553 | 主进程入口：窗口管理、PTT 全局键盘钩子、IPC 注册 |
| `electron/main/native-microphone.ts` | 488 | 原生麦克风采集（ffmpeg DirectShow） |
| `electron/main/window-manager.ts` | — | 多窗口创建与管理 |
| `electron/main/menu-manager.ts` | — | Electron 菜单管理 |
| `electron/main/bilibili-live-bridge.ts` | — | B 站直播桥接 |
| `electron/main/esp32-display-bridge.ts` | — | ESP32 副屏桥接 |
| `electron/preload/index.ts` | 220 | 上下文桥接，暴露桌面 API |

### 6.2 发现问题

#### P1：原生麦克风 Windows 缺少进程树兜底

`native-microphone.ts` 使用 `process.kill("SIGTERM")` 停止 ffmpeg。文档 §3.0 已确认为问题——Windows 下 SIGTERM 不会传播到子进程树，ffmpeg 子进程可能残留。虽然有 startup timeout（4秒）和 stderr 监控，但缺少 Windows 下的 `taskkill /T` 兜底。

**建议**：Windows 平台在 SIGTERM 后附加 `taskkill /T /PID <pid>` 兜底。

#### P2：uiohook-napi 全局 PTT 钩子缺少降级通知

不可用时（Linux / 缺少系统权限）只 `console.warn` 后设 `uiohookModule = null`。后续 `globalPttKeycode` 有值但 hook 不可用时静默跳过。用户不知道全局 PTT 模式不可用。

**建议**：通过 IPC 向前端发送 `"global-ptt-unavailable"` 事件，让设置界面显示降级提示。

#### P2：preload 双命名 API 暴露

同时暴露 `window.ag99desktop` 和 `window.api` 两种入口。文档 §3.0 要求"明确兼容窗口，避免双入口长期并存"。

**建议**：逐步消除 `window.api`，统一到 `window.ag99desktop`。

### 6.3 合规项

- ✅ Microphone capture 启动时有握手确认（等第一批 PCM 字节），已补齐 ready 判定
- ✅ 音频数据格式统一：Electron ffmpeg `s16le`、Web fallback AudioWorklet 转 PCM16LE
- ✅ PTT 事件使用 `turn_id` + `stream_id` 独立生命周期
- ✅ 支持原生路径和 Web fallback 双采集方案

---

## 7. 音频链路

### 7.1 结构

```
前端采集:
  Electron native → ffmpeg s16le PCM16LE chunks
  → input.audio_stream_start / binary frame / input.audio_stream_end
  → WebSocket binary AG99 帧

后端:
  SpeechIngressService → AudioStreamState[stream_id] → VAD → STT → AstrBotMessage

TTS 输出:
  后端生成 WAV → /cache/audio/*.wav → output.audio.audio_url
  前端:
    startAudioPlayback (HTMLAudioElement 全局单例)
    → 音频 played 事件通知 useModelEngine → SpeechPoseStage
```

### 7.2 发现问题

#### P2：音频播放 `audioElement` 全局单例

`audioPlayback.ts:20` 声明 `let audioElement: HTMLAudioElement | null = null`。符合当前单实例设计，但：
- 不支持并行音频播放
- 同一时间只能有一个 segment 音频在播放
- 竞态下第二段音频调 `startAudioPlayback` 会直接 `stopAudioPlaybackRuntime()` 替换第一段

#### P2：Lip sync 集成路径不清晰

`startAudioPlayback` 调 `prepareLipSync` 但不清楚它与 `VoiceFollowingProfile` 或 `mouth_open` 轴的关联。文档 §SpeechPoseStage 明确"不做逐帧口型、不做 RMS/phoneme/viseme"，但 lip sync 的 fallback 行为没有在文档或测试中定义。

**建议**：明确 lip sync 的当前边界文档化——具体哪些场景由 SDK 处理、哪些由口径轴处理、哪些尚未实现。

### 7.3 合规项

- ✅ 音频播放的 ended/error 事件处理完备，每个事件有 `audioElement === audio` 的归属校验
- ✅ Binary audio frame 使用 AG99 prefix + sequence + stream_id 的协议设计避免了帧重排
- ✅ Stream end 携带 `dropped` 标记，后端可直接丢弃残缺音频段
- ✅ `SpeechIngressService` 使用 `AudioStreamState` 按 stream_id 聚合，防止不同录音段串音

---

## 8. 后端全局状态 RuntimeState

### 8.1 概况

**文件**：`runtime/state.py`（约1282行）及 `runtime/motion_state/tuning_store.py`（约611行）

`RuntimeState` 已将 Motion tuning 样本持久化、校验和 prompt 投影拆到独立 store，但主文件仍混合：
- 配置管理（`plugin_config` 的 clone/refresh）
- 模型扫描和缓存生命周期
- LLM action filter 的执行
- ~70 个运行时布尔/数字/字符串/列表字段
- 语义轴 profile 的加载和刷新
- 配置热加载（`_start_config_watch`）

### 8.2 发现问题

#### P2：单一对象承载所有状态，耦合链过长

`RuntimeState` → 直接调 `scan_live2d_models()`（3010行 scanner）→ `motion_scan.py` → 文件系统。一次模型刷新触发从文件 I/O 到 profile 构建的全链路，无法中断或取消。

**建议**：至少将扫描/缓存刷新与运行时配置分离。扫描/刷新独立为 Service 或 Worker。

#### P2：状态变更缺少 centralized 发布/订阅

各模块通过 `runtime_state.xxx` 直接读写，变更不触发事件。新的配置项依赖者需要自己决定在何时读取。

### 8.3 合规项

- ✅ 有 `deepcopy` 用于配置隔离
- ✅ 扫描和 profile 构建有缓存层（`runtime_cache.py` + MD5 hash）
- ✅ 配置热加载路径有 `_start_config_watch`
- ✅ Motion tuning 样本管理已按领域拆到 `runtime/motion_state/tuning_store.py`，`RuntimeState` 保留兼容门面

---

## 9. Live2D Scanner

### 9.1 概况

**文件**：`live2d/scanner/scan.py`（3010行）

项目最大文件，混合多职责：

| 职责 | 大致占比 |
|------|----------|
| 参数扫描（统计、聚类） | ~30% |
| 动作资源分解 | ~25% |
| Expression 参数抽取 | ~15% |
| 语义轴 profile 构建 | ~20% |
| 标准通道定义 / 资源缓存校验 | ~10% |

### 9.2 发现问题

#### P2：3000 行单文件，开发/测试/重构成本高

- 单模块测试需要 mock 整个文件系统，测试边界模糊
- 多人同时开发时冲突风险高
- 改动一处可能影响其他职责

**建议**：拆为资源扫描、参数分析、动作分析和 profile 构建四个独立模块。

### 9.3 合规项

- ✅ `STANDARD_CHANNEL_SPECS` 定义清晰，涵盖 Live2D 标准参数通道
- ✅ 使用 MD5 缓存避免重复扫描大模型目录
- ✅ `SCAN_SCHEMA_VERSION` 版本号控制缓存失效

---

## 10. Protocol Parser

### 10.1 概况

**文件**：`protocol/parser.py`（312行）、`frontend/src/adapter-connection/inbound/inboundPayloads.ts`（400行）

### 10.2 发现问题（关联 §3.2 P0）

后端 `parser.py` 已经做了：
- 顶层 envelope 字段类型校验
- `message_type` 必须在 `INBOUND_ALLOWED_TYPES` 内
- `payload` 要求是对象

但深层校验粒度因类型而异：
- `input.text`：校验 `text` 字段存在且非空 ✅
- `input.audio_stream_*`：校验 `stream_id` 非空 ✅
- `system.semantic_axis_profile_save`：校验完整 profile ✅
- `system.model_sync` / history payloads / motion tuning state：校验较宽松 ⚠️

这意味着深层嵌套对象的完整性依赖各接收模块自己的 `normalize` 逻辑（前端 `inboundPayloads.ts` 和后端 `state.py`）。

### 10.3 合规项

- ✅ 入站出站分离，`parser.py` 只做协议层校验
- ✅ 业务语义处理由 `turn_coordinator.py` 负责
- ✅ 前端 `inboundPayloads.ts` 已覆盖主要 output.*/control.*/system.* 的 payload shape 校验

---

## 11. 远程 Operator 子系统

### 11.1 概况

- `middleware/remote_operator.py`（703行）
- `services/remote_operator_runtime.py`（967行）

功能完整的远程桌面控制子系统，允许 LLM 执行打开浏览器、截图、运行命令等桌面操作。

### 11.2 发现问题

#### P2：与 Live2D 核心功能的耦合关系不清晰

- 是否允许在 Live2D 对话中触发远程操作？
- 远程操作返回结果时如何影响角色表情？
- 远程 operator 超时/失败如何通知用户？

文档中没有这些问题的说明。`interaction_motion.py` 中有处理 remote operator 结果的 contributors，但集成测试覆盖不足。

#### P3：安全边界依赖静态黑名单

`REMOTE_OPERATOR_CONFLICTING_TOOL_NAMES` 定义工具名黑名单阻止 LLM 调用危险工具。但白名单/黑名单的安全模型是静态的，依赖管理员配置。如果 `default_computer` 指向生产服务器，LLM 可能通过浏览器或文件操作造成实际损害。

**建议**：补充文档说明 remote operator 安全边界和推荐配置。

---

## 12. 测试体系

### 12.1 规模

| 域 | 文件数 | 覆盖模块 |
|----|--------|----------|
| 前端 TypeScript | 14 个 test 文件 | session、orchestrator、coordinator、model engine、adapter connection、inbound events、inbound protocol、PTT、desktop bridge |
| 后端 Python | 23 个 test 文件 | turn coordinator、interaction motion、semantic profile、runtime state、speech ingress、websocket、remote operator |

### 12.2 发现问题

#### P1：前端测试脚本重复编译

`frontend/package.json` 的每个 test script 独立执行 `tsc --outDir <test-out-xxx>`，`npm test` 时重复编译全部 TypeScript 源代码 14 次。文档 §3.0 要求"合并为单次测试编译或迁移 Vitest"。

**建议**：迁移到 Vitest 获得 watch 和覆盖率能力，或至少合并为单次 `tsc` 编译。

#### P1：缺少高价值集成场景测试

从文件名看，后端测试覆盖面已较好，但缺少：
- WebSocket 重连场景：没有测试模拟连接中断后前端的恢复行为
- 音频流片段乱序到达：没有测试 binary audio frame 乱序重排
- synth_finished 后晚到 output.audio 的竞态处理
- 多 segment 之间的 soft handoff 时序
- profile 版本冲突（前后端 profile_revision 不一致）的降级

#### P2：前端测试缺少统一的 mock helper 层

`window.getLAppAdapter` 等全局 API 需要手动 mock，不同测试之间 mock 不一致。建议提取到 `conftest` 风格的 setup 模块。

### 12.3 合规项

- ✅ 前端 session state 测试覆盖了 phase 转移、segment 创建、晚到媒体等关键路径
- ✅ 后端 `test_turn_coordinator_realtime_motion.py` 有 1492 行，覆盖多种 motion intent 场景
- ✅ `conftest.py` 提供了 fixture 基座

---

## 13. 全局优先级排布

### P0 — 正确性缺口

| # | 问题 | 领域 | 影响 |
|---|------|------|------|
| 1 | `stableAxisDirection` 伪随机 hash 方向 | Live2D / Semantic | 说话时头身偏移方向不可控，用户感知异常 |
| 2 | SDK 参数计划缺少完成事件回调 | Live2D | timer 替代真实完成信号，负载高时可能误报 |
| 3 | 深层协议 parser 未覆盖 system.model_sync 等路径 | 链路安全 | 入站边界校验不全，恶意数据可绕过 parser |
| 4 | 链路回归测试不足（多 segment、晚到竞态、soft handoff） | 全局 | 现有修正缺少保护 net，退化不可见 |

### P1 — 重要维护项

| # | 问题 | 领域 | 影响 |
|---|------|------|------|
| 5 | 桌面快照同步时序保护缺失 | Desktop Bridge | 旧快照可能覆盖新快照 |
| 6 | 原生麦克风 Windows 进程树兜底 | Electron | ffmpeg 子进程可能残留 |
| 7 | Repair/fallback 命中率缺少观测指标 | Semantic | 开发阶段看不到 LLM 输出质量退化 |
| 8 | 前端测试重复编译 | 工程 | 运行全部测试成本高，阻碍 CI 集成 |
| 9 | turn_coordinator.py 1004 行单文件 | 后端链路 | 每改协议都触及此文件 |
| 10 | useAdapterConnection.ts 622 行门面偏大 | 前端链路 | 新增能力不容易确定归属 |
| 11 | 音频播放全局单例 + lip sync 路径不明确 | 音频 | 不支持并行音频，lip sync 边界未文档化 |

### P2 — 渐进改进

| # | 问题 | 领域 |
|---|------|------|
| 12 | session phase 状态迁移的分散触发点需测试保护 | 链路 |
| 13 | RuntimeState 已拆出 motion tuning，仍需拆分扫描/配置 | 后端 |
| 14 | Scanner 3010 行需拆分四个子模块 | 后端 |
| 15 | PTT 全局钩子不可用时通知前端 | Electron |
| 16 | DPR cap 1.25 配置化 | Live2D |
| 17 | preload 双命名 API 收敛 | Electron |
| 18 | 远程 Operator 安全边界文档化 | 文档 |
| 19 | 从 `console.info` 迁移到统一 logger | 工程 |
| 20 | WebSDK 最小类型检查 | Live2D |

---

## 14. 后续处理记录

> 更新时间：2026-06-11
>
> 记录口径：本节记录审阅后第一批修复和范围重新确认结果。原审阅发现保留为当时判断；后续实现和真实生产路径以本节状态为准。

### 14.1 已修复 / 已接线

#### 1. `stableAxisDirection` 伪随机方向

状态：已处理。

处理内容：

- `VoiceFollowingChannelProfile` 增加 `direction?: 1 | -1`，允许语音随动 channel 显式声明偏移方向。
- `SpeechPoseStage` 不再直接用 axis id 字符串 hash 决定 voice following 方向。
- 已知 channel 走确定映射：`head_yaw`、`body_yaw`、`head_roll`、`body_roll`、`gaze_x` 默认正向；`head_pitch`、`body_pitch`、`gaze_y` 默认反向。
- legacy speech pose 改为从 axis id、label、description、positive/negative semantics 推断方向。
- 旧 hash 函数保留为 deprecated 兼容 fallback，并在命中时输出 warning，方便后续发现未迁移模型。

涉及文件：

- `frontend/src/types/protocol.ts`
- `frontend/src/model-engine/compiler/stages/speechPoseStage.ts`

#### 2. Direct Parameter Plan 完成事件

状态：已处理。

处理内容：

- `LAppModel.startDirectParameterPlan()` 支持 `runId` 和 `onTerminal`。
- `LAppModel.stopDirectParameterPlan()` 在 completed / stopped / failed / rejected 路径发出终态事件，并用 `terminalEmitted` 防止重复发射。
- `LAppAdapter` 透传 direct parameter plan options 和 stop reason/status。
- `usePreviewMotionPlayer.playPlan()` 生成前端 playback runId，并把 SDK terminal event 回传给调用方。
- 原先 `totalDurationMs + 40` 的完成 timer 改为 watchdog；watchdog 超时视为 failed，不再作为正常完成依据。
- `usePlaybackCompletionCoordinator` 新增 `completeMotionPlayback(event)`，按 runId 校验后完成或失败对应 segment，不再 watch 全局 `motionPlayer.state.status` 来推断归属。
- `usePetDesktopRuntime` 已把 parameter plan 的 `onFinished` 接到 `playbackCoordinator.completeMotionPlayback()`。

涉及文件：

- `frontend/src/live2d/WebSDK/src/lappmodel.ts`
- `frontend/src/live2d/WebSDK/src/lappadapter.ts`
- `frontend/src/types/live2d-runtime.d.ts`
- `frontend/src/live2d-renderer/usePreviewMotionPlayer.ts`
- `frontend/src/model-engine/runtime/contracts.ts`
- `frontend/src/model-engine/runtime/motionStart.ts`
- `frontend/src/turn-playback/usePlaybackCompletionCoordinator.ts`
- `frontend/src/app/usePetDesktopRuntime.ts`

#### 3. 动作完成归属从“全局播放器状态”改为 runId

状态：已处理。

处理内容：

- `ModelEnginePlanStartedEvent` 增加 `runId`。
- semantic intent 和 direct parameter plan 启动成功后，把播放器返回的 runId 写入 playback record。
- coordinator 记录当前 `{ runId, segmentKey }`，terminal event 必须 runId 匹配才会收口。
- stale terminal callback 不会误完成当前 segment。
- soft handoff 时，旧 segment 仍按 `motion_handed_off` 收口，新 segment 由新 runId 负责完成。

涉及文件：

- `frontend/src/model-engine/runtime/contracts.ts`
- `frontend/src/model-engine/runtime/motionStart.ts`
- `frontend/src/turn-playback/usePlaybackCompletionCoordinator.ts`
- `frontend/tests/playbackCompletionCoordinator.test.ts`

#### 4. 动作 start 失败不再让 segment 永久等待

状态：已处理。

处理内容：

- ModelEngine runtime 依赖中补充 `markMotionFailed` 端口。
- 动作 payload 编译失败、启动失败或被 runtime 拒绝时，能够把对应 `turnId + messageId` 的 motion 标记为 failed。
- 本地播放完成判断可以把 failed motion 视为 terminal，避免 segment 卡住。

涉及文件：

- `frontend/src/model-engine/runtime/contracts.ts`
- `frontend/src/model-engine/runtime/motionStart.ts`
- `frontend/src/model-engine/useModelEngine.ts`
- `frontend/src/app/usePetDesktopRuntime.ts`
- `frontend/src/turn-playback/usePlaybackCompletionCoordinator.ts`

### 14.2 已重新定性 / 本批不修

#### catalog motion / 现成动作段完成回调

原问题表述：`engine.catalog_motion` 如果进入 turn playback 主链路，当前生产装配没有调用 `completeMotionPlayback()`，现成动作段可能停在 `motion.started=true`，导致整轮无法 settled。

重新确认后的结论：

- 当前自动动作生产链路不发送 `engine.catalog_motion`。
- 当前后端给前端的主链路消息不包含 catalog motion 内容。
- 当前主链路仍是 `engine.motion_intent.v3` / `engine.parameter_plan.v2`，不把预录制 motion / expression 接入自动播放。
- 因此该问题不是当前生产 P0，而是未来预录制资产层接入时必须处理的前置风险。

当前处理：

- 不在本批把 catalog motion 接入 `completeMotionPlayback()`。
- 不为 catalog motion 新增 runId / terminal callback 生产接线。
- 保留现有动作实验室、预览、手动调试能力。
- 已新增 `docs/02-设计文档/09-预录制资产层设计.md`，把预录制 motion / expression 定位为后续 `Asset Accent Layer`，不回流当前自动 LLM 动作主链路。

后续如果启用 Asset Accent Layer，再按以下协议补齐：

```text
catalog / asset motion start
  -> runId
  -> SDK motion finished callback 或 watchdog
  -> completeMotionPlayback(runId)
  -> markMotionCompleted / markMotionFailed
  -> maybeFlushPlaybackCompletion
```

### 14.3 后续状态更新

#### 1. 深层入站协议 parser

状态：已处理。

原范围：

- `system.model_sync.model_info`
- `runtime_cache_errors`
- history payloads
- `system.motion_tuning_samples_state`
- window/devtools bridge 的 `applyUnknownMessage`

处理结果：

- `parseInboundEnvelopeObject()` 已接入 window/devtools 入口。
- `parseSystemModelSyncPayload()` 已分层解析 `model_info.models[]`、`selected_model`、`semantic_axis_profile` 和 `runtime_cache_errors`。
- history / motion tuning 端口已改用 typed envelope。
- 畸形 `runtime_cache_errors` 不再静默丢弃，而是作为 payload parse failure。

#### 2. 链路回归测试补强

状态：部分补强，仍需继续。

已补强：

- `synth_finished` 早于晚到 `output.audio`。
- 多 segment 连续动作和 soft handoff。
- stale runId terminal callback 不误完成当前 segment。
- motion start failed 后整轮可以 settled。
- interrupt / reconnect / switch_model 停止动作后不悬挂。
- 深层 parser 拒绝畸形 `system.model_sync` 和 window/devtools 注入消息。

仍建议继续覆盖：

- WebSocket 重连后的前端恢复行为。
- binary audio frame 乱序 / 重复 / 丢帧场景。
- profile revision 冲突时的降级路径。
- 更贴近真实多窗口场景的 snapshot 同步测试。

#### 3. 桌面快照 revision / publisher 时序保护

状态：已处理。

处理结果：

- `DesktopRuntimeSnapshot` 增加 `_publisherId` 和 `_revision`。
- 发布端每次 publish 递增 revision。
- 接收端同一 publisher 只接受 revision 严格递增的快照，降低旧快照覆盖新快照的风险。

#### 4. Repair/fallback 命中率观测

状态：部分处理，仍可增强。

处理结果：

- `realtime_motion_plan.py` 已有 `_repair_stats`、`get_repair_stats()`、`reset_repair_stats()` 和 `maybe_log_repair_stats()`。
- 已记录 duration 默认/裁剪、fallback resolve / neutral fallback 等基础原因。

后续建议：

- 把 middleware-first、inline-first 和 realtime fallback 的统计口径统一。
- 提供稳定的诊断输出入口，而不只依赖间隔日志。
- 统计按 session / provider / model 维度聚合，方便观察不同模型的动作输出质量。

#### 5. Electron / Live2D 近期修复

状态：已处理。

处理结果：

- DPR cap 已配置化：`ModelEngineSettings.live2dRenderDprCap`、设置页滑块、快照同步和 renderer resize 均已接线。
- 原生麦克风 Windows 进程树兜底已补齐：停止 ffmpeg 时增加 `taskkill` 兜底，避免子进程残留。
- PTT 全局钩子不可用通知已补齐：主进程发布 `pttHookStatus`，前端设置页显示降级提示。

---

## 附录：用户确认纪要

本次审阅完成后，用户逐条核验并提供了修正，核心变更记录如下（无文件改动，仅确认方向）：

1. **`stableAxisDirection` 确认为真问题**，优先级最高。修复方向：channel 显式 direction / signed amplitude / target_value。
2. **动作完成 timer 确认为真问题**。修复方向：SDK run_id + 事件回调，timer 只做 watchdog。
3. **入站协议"完全裸奔"表述过重**，但 `system.model_sync` 和 `applyUnknownMessage` 入口确实是薄弱点。
4. **"无状态机"不准确**——`VALID_PHASE_TRANSITIONS` 存在，风险在触发点散布而非状态定义缺失。
5. **useAdapterConnection 和 turn_coordinator 体量偏大**但非完全无边界，建议渐进拆分而非大重写。
6. **"动作生成只靠修复层"修正为**：prompt + repair/fallback 双保险已成型，但缺少命中率观测指标。

全部确认结论：**先把 stableAxisDirection、SDK 完成事件、深层 parser、回归测试四个钉牢，后面的拆分会顺很多。**

---

## 后续修复状态（截至 2026-06-15）

以下条目为上一轮审阅报告中的问题，当前已修复或部分处理：

| 状态 | 问题 | 涉及文件 | 修复方式 |
|------|------|---------|---------|
| ✅ 已修复 | `stableAxisDirection` 伪随机方向 | `protocol.ts`, `speechPoseStage.ts` | VoiceFollowingChannelProfile 增加 direction 字段；新增 `resolveVoiceFollowingDirection()` / `defaultVoiceFollowingDirection()`；legacy speech pose 改用 `resolveSpeechPoseAxisDirection()` |
| ✅ 已修复 | SDK 完成事件依赖 `setTimeout` | `live2d-runtime.d.ts`, `lappadapter.ts`, `lappmodel.ts`, `usePreviewMotionPlayer.ts` | DirectParameterPlanState 增加 runId/onTerminal/terminalEmitted；stopDirectParameterPlan 发射完成事件；前端 `onTerminal` 回调为主路径，timer 降级为 watchdog |
| ✅ 已修复 | 动作完成归属缺少 `runId`/`messageId` | `contracts.ts`, `motionStart.ts`, `usePlaybackCompletionCoordinator.ts`, `usePetDesktopRuntime.ts` | `ModelEnginePlanStartedEventBase` 增加 runId；coordinator 用 `currentMotionRun {runId, segmentKey}` 跟踪；`completeMotionPlayback` 校验 event.runId；`findSegmentByKey` 替代手写 split |
| ✅ 已修复 | Soft handoff duplicate 丢失真实 runId | `usePreviewMotionPlayer.ts` | 增加 `lastPlaybackRunId` 状态变量，复用分支传 `lastPlaybackRunId` 而非空串 |
| ✅ 已修复 | `stopped` 中断场景不标记 motion failed | `usePlaybackCompletionCoordinator.ts` | `stopped` 分支按 reason 判断：`interrupted`/`reset`/`switch_model`/`reconnect` 标记 motion failed |
| ✅ 已修复 | 入站协议深层透传路径 | `inboundProtocol.ts`, `inboundPayloads.ts`, `useModelSync.ts`, `inboundFeatureDispatcher.ts` | `parseInboundEnvelopeObject()` 供 window/devtools 入口；`parseSystemModelSyncPayload` 分层 parse `model_info.models[]`、`selected_model`、`semantic_axis_profile`；`applyUnknownMessage` 改走 parser；history/motion tuning 端口改用 typed envelope |
| ✅ 已修复 | parser 裁剪后端字段 | `inboundPayloads.ts` | `parseModelSummarySnapshot` 改为 spread 原始 record 并覆盖已验证的 name；`model_info` 同理 spread 保留 `schema_version`/`driver_priority`/`available_models` |
| ✅ 已修复 | `runtime_cache_errors` 畸形值静默丢弃 | `inboundPayloads.ts` | `parseRuntimeCacheErrorsPayload` 改为返回 `PayloadParseResult`，非 object 时整体 reject |
| ✅ 已修复 | 桌面快照缺少时序控制 | `desktop.ts`, `runtimeSnapshot.ts`, `usePetRuntimeSnapshotPublisher.ts`, `useDesktopBridge.ts` | `_publisherId` + `_revision` 字段；发布端每次 publish 递增 revision；接收端同一 publisher 只接受 revision 严格递增的快照 |
| ✅ 已修复 | coordinator 测试依赖旧全局 watch | `playbackCompletionCoordinator.test.ts` | 改为直接调 `completeMotionPlayback({runId, status})`；新增 stale runId、interrupt、late audio reopen、multi-segment 四个回归测试 |
| ✅ 已修复 | DPR cap 配置化 | `settings.ts`, `useLive2dRenderer.ts`, `SettingsWindowView.vue`, `DesktopPetCanvas.vue` | 新增 `live2dRenderDprCap` 设置、设置页滑块、快照应用和 renderer redraw；默认仍保持保守值 1.25 |
| ✅ 已修复 | 原生麦克风 Windows 进程树兜底 | `native-microphone.ts` | 停止 ffmpeg 时增加 Windows `taskkill` 兜底，并处理 timeout / failure 日志 |
| ✅ 已修复 | PTT 全局钩子不可用时通知前端 | `index.ts`, `preload/index.ts`, `useAdapterConnection.ts`, `SettingsWindowView.vue` | 主进程维护 `pttHookStatus`，前端读取并在设置页展示全局按键不可用降级提示 |
| ✅ 部分处理 | Motion repair/fallback 缺少命中率观测 | `realtime_motion_plan.py`, `fallback_pose.py` | `_repair_stats` 模块级 dict + `_incr_repair_stat()`/`get_repair_stats()`/`reset_repair_stats()`；`duration_hint_defaulted`/`clamped`、`fallback_resolve_requested`/`fallback_used_neutral` 埋点 |
| ✅ 部分处理 | `runtime/state.py` 全局状态混合 | `runtime/state.py`, `runtime/motion_state/tuning_store.py` | 已拆出 motion tuning 样本持久化、校验和 prompt 投影；主文件约 1282 行，扫描、配置和缓存职责仍待继续拆分 |
| ⚠️ 未处理 | `live2d/scanner/scan.py` 3010 行多职责混合 | — | 待后续拆分 |
| ⚠️ 未处理 | `turn_coordinator.py` 1004 行集中 | — | 待后续拆分 |
| ⚠️ 未处理 | `useAdapterConnection.ts` 653 行门面偏大 | — | 待后续拆分 |
| ⚠️ 未处理 | preload 双命名 API 收敛 | — | 待后续处理 |
| ⚠️ 未处理 | 前端测试重复编译 | `frontend/package.json` | 待合并单次 test build 或迁移 Vitest |
| ⚠️ 未处理 | WebSDK 最小类型检查 | `frontend/tsconfig.json`, `frontend/src/live2d/WebSDK/**/*` | 当前仍从 renderer tsconfig exclude，待逐步纳入 adapter / direct parameter plan 类型保护 |
| ⚠️ 未处理 | `console.info` 迁移统一 logger | 前端 / Electron / WebSDK 多处 | 待后续日志治理 |
| ⚠️ 未处理 | 远程 Operator 安全边界文档化 | `docs/02-设计文档/07-远程执行器接入设计.md`, adapter README | 待补充生产环境推荐配置、默认电脑风险和能力边界 |
