# Interaction Evolution

## 1. Current Interaction Diagnosis

AG99live 已经具备“回复期间表演”的完整骨架：AstrBot 生成回复，Adapter 聚合 `OutputSegment`，前端用 `PlaybackTimeline` 协调音频、动作和口型，`ModelEngine` 编译语义动作，Live2D runtime 逐帧执行。

当前主要缺口不是动作数量，而是完整的交互因果感。文本提交与 PTT 结束录音后会进入本地 `thinking sway`：角色在后端等待期间保持轻微、慢速的左右摆动；首段回复动作启动时，该贡献在参数混合器内退场并由回复动作接管。自动可信 speech-start 与首句级音频仍未接入，因此从“注意到用户”到“理解并回答”的连续状态还不完整。

## 2. Latency Map

```text
用户输入
  → 麦克风启动 / PTT
  → VAD 检测
  → 结束讲话
  → 完整音频写入临时 WAV
  → STT final
  → AstrBot event commit
  → LLM request / first token
  → 完整回复聚合
  → TTS 完成音频文件
  → logical OutputSegment finalized and sent
  → 前端收到 segment
  → Timeline 建立
  → 音频 metadata ready
  → audio.play()
  → motion preparation / compilation
  → Live2D 首帧
```

当前代码能够确认的阻塞点：

- VAD 需要按窗口处理样本，并等待静音条件。
- STT 等完整音频段和 `get_text` 返回；没有 partial STT。
- `TurnCoordinator` 将 `enable_streaming` 设置为 `False`。
- 回复侧使用完整 `Record` 文件，不是增量 TTS 或音频 chunk 流。
- 增强版 Core 在一条逻辑消息的全部物理组件成功派发后调用
  `complete_visible_message(message_id)`；`OutputSegmentCoordinator` 随即发送该原子段。
  `close_turn_output_queue()` 只确认不存在 pending segment 后发送 `control.synth_finished`，不再承担
  整轮 flush。
- 浏览器音频先加载并取得 duration，再开始播放。

麦克风首帧前还存在一个前端冷启动链路：

```text
PTT keydown
  → getUserMedia（首次还可能弹出权限）
  → 创建/恢复 AudioContext
  → 加载 AudioWorklet module
  → 创建并连接 source / worklet / sink 节点
  → 第一段 PCM
```

PTT 模式现在会在运行时初始化后立即申请并保持 MediaStream、AudioContext 与 AudioWorklet；松键只关闭
当前 `input.audio_stream`，不会关闭设备或音频图。因而首次启用仍可能包含权限等待，但后续按键不再重建
采集运行时。这段等待与 VAD、STT 和后端 WebSocket 无关，必须单独测量 `PTT keydown -> first PCM`。

可并行或前移的部分：

- PTT 按下、文本提交和可信 speech-start 可以立即触发视觉反应。
- LLM 后续生成、后续短语 TTS、后续段排队可以与首段播放并行。
- 动作准备可以在音频 duration ready 后立即进行，不必等待整轮完成。

实际毫秒数无法从源码证明，必须先测量。特别要检查后端 WebSocket 接收循环在 STT await 期间是否造成控制消息或音频帧积压。

## 3. Measurement Plan

建议记录以下单调时钟事件：

```text
input_intent
capture_requested
capture_ready
first_pcm_received
vad_detected
speech_end_detected
stt_request
stt_final
event_committed
llm_request
llm_first_token
first_semantic_chunk
tts_request
tts_first_chunk
tts_segment_ready
segment_ready
segment_sent
segment_received
timeline_scheduled
audio_metadata_ready
motion_compile_start
motion_compile_end
audio_start
reaction_first_frame
semantic_motion_first_frame
audio_end
motion_terminal
turn_local_settled
turn_finished_received
```

指标定义：

| 指标 | 定义 |
|---|---|
| TTFR | 用户意图到第一次由本次输入触发的视觉反应 |
| TTFA | 讲话结束到第一段回复音频实际开始播放 |
| TTFSM | 讲话结束到第一帧具有当前回复语义的动作 |
| Interrupt Latency | speech/PTT 检测到停止当前声音、视觉接管和后端取消确认的分段耗时 |
| End-to-End Turn Latency | 用户意图到本地播放完全收口 |

要区分 `software playing` 与扬声器真正出声；后者需要回录或 loopback 验证。所有跨进程 trace 都应带 `capture_id / turn_id / message_id / run_id`。

## 4. Highest-Value Improvements

| 优先级 | 改进 | 体验收益 | 工程成本 |
|---|---|---:|---:|
| P0 | PTT、文本提交或可信 speech-start 后立即 attention reaction | 5/5 | 低 |
| P0 | PTT 按下立即停播并转入 listening | 5/5 | 低至中 |
| P1 | 首句/短语级完整文件 TTS 与 segment 流水线 | 5/5 | 中高 |
| P1 | 回复结束后的短暂姿态 residue | 4/5 | 中 |
| P1 | processing 与 speaking 的平滑接管 | 4/5 | 低至中 |
| P2 | 自动 barge-in、跨来源取消和回声验证 | 5/5 | 中高 |
| P2 | 调校已有 bounded variation 与 idle 目标变化 | 3/5 | 低 |
| P3 | partial STT 与音频 chunk streaming | 未知 | 高 |

Performance Curve 第二模型调用不应成为下一阶段优先投资。它在动作意图已经存在后才请求，不能改善用户开口时的反应，也不缩短主模型或 TTS 首响。应先关闭或做 A/B，证明命中率和观感收益后再决定去留。

## 5. Immediate Reaction Design

Reaction 与 Answer 应解耦。Reaction 不需要理解用户内容，只需要响应可观测事件：

```text
PTT / speech-start
  → attention 上升
  → 抑制无关 ambient
  → 小幅 gaze / head response
  → listening

speech-end
  → processing / anticipation

首段可播
  → speaking 接管

audio-end
  → residue 收势
  → attentive idle
```

最小实现不需要 `ReflexEngine`：

- 事件选择和阶段更新放在现有桌面运行时。
- 反应动作复用 ModelEngine 的本地 plan 和现有 Profile。
- 参数呈现复用 `ActiveParameterRuntime`、Mixer 和 `ParameterPresentation`。
- 回答开始时用已有 plan replacement 接管反应计划。
- 本地反应不加入后端 turn，也不参与 playback ACK。

PTT 是最可靠的第一实验入口。自动 VAD 后续可增加轻量 speech activity 通知；低置信度信号先改变注意和音量，可信信号再取消回答。

## 6. Streaming Strategy

当前已有音频输入 streaming、前端按段调度、动作 phrase segmentation 和后续动作接管，但回复侧不是流式：LLM streaming 被关闭，STT 等完整段，TTS 输出完整文件。增强版 Core 已可在单条逻辑消息
完成后立即发布原子 `OutputSegment`，但当前 Core 尚未产生能让第一句先封口的增量逻辑消息。

推荐先做“短语级完整文件”，而不是立即做音频 chunk streaming：

```text
单次 LLM 生成
  ├─ phrase A 封口 → TTS A → segment A → 立即播放
  ├─ phrase B 封口 → TTS B → segment B → 排队
  └─ phrase C 封口 → TTS C → segment C → 排队
```

现有 Atomic Output Segment 适合保留，但需要把“段内原子”和“整轮原子”分开：

1. Core 产生语义完整、身份稳定的短段。
2. Adapter 允许同一 turn 多次发布已封口 segment。
3. `synth_finished` 只表示不会再有新段，不再是第一段播放的前置条件。
4. 前端继续使用每段自己的音频时钟和顺序调度。
5. 取消后禁止晚到 segment 复活旧 turn。

这会主要影响 AstrBot Core 的输出封口和 Adapter 的段状态，不需要重写 Timeline。LLM 调用不必增加；TTS 调用可能增加，需要用 TTFA、段间静音、韵律和成本验证。

## 7. Liveliness Model

先不要建设完整生命场。最小可行状态是：

| 状态 | 作用 | Owner |
|---|---|---|
| `interactionPhase` | idle/listening/processing/speaking | 主窗口运行时 |
| `attention` | 面向用户的关注强度 | 主窗口运行时 |
| `activation` | 表现活跃度和动作幅度预算 | 主窗口运行时；ModelEngine 读取 |
| `residue` | 上一动作留下的短暂目标和权重 | 参数呈现层 |

状态在事件发生时更新，没有事件时向阶段基线衰减。它们只调制动作幅度、速度、ambient 权重和收势，不决定回复文本，也不写入通用 Memory。

比较：

| 方案 | 收益 | 成本 | 判断 |
|---|---|---|---|
| A：现有 Motion + Timeline 加事件反应 | 高 | 低 | 现在开始 |
| B：简单 Continuous Performance State | 中高 | 中 | A 验证后增加 |
| C：生命场 / cellular dynamics | 未知 | 高 | 当前不做 |

## 8. Motion Continuity

已有能力：

- `PerformanceSchedule` 的 residual、hesitation 和 speech cue 对齐。
- gaze lead、face delay、body follow 等 temporal staggering。
- ModelEngine plan replacement 会转移重合参数的 `drivenOffset` 和 `velocity`。
- `ParameterPresentation` 已有速度、加速度和响应曲线。
- 轴采样使用包含 turn/message/profile 的 seed，具有有界、可重现 variation。
- Live2D runtime 已将主动参数融合放在 Physics 之前。

仍然值得补的部分：

- plan 完全释放后的短暂姿态 residue。
- residue 与 ambient 的权重协调。
- 新输入发生时 residue 的平滑接管和清理。

不要重新实现惯性、eye lead、body follow 或逐帧随机。variation 应在计划创建时采样，保留 seed，不能在每帧重新采样；只改变幅度、停留和过渡，不改变语义方向。

空闲表现建议采用：

```text
recent residue + attention target + activation + 低频有界目标变化
→ 现有平滑呈现
```

保留静止间隙，避免固定周期动作、无意义抖动和永远回到 neutral。

## 9. Interruption / Turn Taking

当前主动中断路径已经具备本地停播、Timeline 清理、后端 `control.interrupt`、事件 stop 标记、pending output 清理和 curve task 取消。

```text
Current:
用户主动中断
  → 本地 stop audio
  → 发送 control.interrupt
  → 后端 stop_event / agent_stop_requested
  → turn_finished
```

自动语音打断目前只在同一 capture 与 VAD child turn 关联时处理；PTT 按下没有自动连接到停播，跨来源 barge-in 不完整。`stop_event()` 也不能证明 LLM/TTS 网络请求已经停止。

推荐流程：

```text
PTT / 可信 speech-start
  ├─ 立即 attention reaction
  ├─ 本地停播或 duck
  ├─ 取消未播 segment
  ├─ motion 接管 listening
  └─ 并行发送后端 interrupt
       ├─ 禁止晚到输出
       ├─ 取消 generation / TTS
       └─ 清理 pending state
```

停播不应等待后端；取消计算、取消 TTS 和 provider 是否真正中止需要在配套 AstrBot Core 中验证。输入接收循环中的 STT await 也应测量是否阻塞控制消息。

## 10. What NOT To Use LLM For

应该由确定性代码、事件、状态机、Timeline、ModelEngine 或简单数值动力学解决：

- 用户开口后的注意变化。
- listening、processing、speaking、idle 状态切换。
- 打断、停播、队列清理和 ACK。
- 眨眼、短暂视线停留、ambient suppression。
- residue 衰减、速度、加速度和部位错峰。
- 音频口型与音频能量耦合。
- variation seed 和可重现计划。

LLM 应负责回复内容、表达态度、语义动作选择和需要上下文理解的强调/犹豫/收束。不要为每个眼神、等待状态或时序细节新增模型调用。

## 11. What NOT To Build

当前不值得建设：

- 新的 Reflex Agent、Life Agent 或 idle Agent。
- 顶层 LifeManager、BehaviorPlanner、第二个 Performance Director。
- cellular dynamics 或大量相互耦合的生命变量。
- 每帧或高频 LLM 调用。
- 每句话一次动作模型调用。
- 为灵动感增加动态插件系统。
- 另一套参数播放器或独立动作时钟。
- 立刻把回复改造成 PCM 音频 chunk 播放器。

## 12. Recommended Evolution Path

### Stage 0：测量与麦克风启动策略

- 做什么：记录 PTT/text submit、`getUserMedia`、AudioContext ready、AudioWorklet ready 与 first PCM 的单调时钟。
- 用户变化：不改变现有录音语义，只能定位按键后等待来自权限、设备打开、音频图还是后续链路。
- 策略选择：PTT 模式期间保持已授权的 MediaStream、AudioContext 与 AudioWorklet；只在按住期间把 PCM
  写入协议输入。用户已明确接受系统持续显示麦克风占用。
- 边界：设备切换、PTT 模式关闭和应用释放必须立即释放资源；WebSocket 重连只结束当前逻辑输入会话，不重建
  PTT 待机音频图。
- 验证：记录首次授权与常驻运行时的 `keydown -> first PCM`，并确认未按键时不会创建 Turn、发送
  `input.audio_stream_start` 或传输任何 PCM。

### Stage 1：思考摆动

- 已完成：桌宠文本提交、弹幕文本提交和 PTT 结束录音均启动 `thinking sway`。它从当前模型的语义轴档案选择可用的横向轴，并作为 `interaction_sway` 原始贡献进入 `ActiveParameterMixer`。
- 边界：它不创建动作计划、播放器、Timeline、后端 Turn 或 MotionLab 历史。回复计划开始时请求其在 Mixer 内退场；最终参数继续只经由 `ParameterPresentation` 和唯一主动参数写入到达模型。
- 待完成：将 thinking 收束到明确的 interaction phase，并增加可信 speech-start。
- 验证：控制台以 `[InteractionSway]` 输出来源、轴和绑定数；实机测量文本提交 / PTT keyup 到首个摆动帧，并检查首段回复动作接管是否平滑。
- 协议/模型调用：不需要改变协议，不增加模型调用。
- 风险：思考贡献必须只使用横向语义轴，且在回复计划激活时及时让权，不能影响口型、Physics 或回复动作的所有权。

### Stage 2：打断即让出话语权

- 做什么：PTT 按下复用本地停播，转入 listening；确认 pending segment 和晚到结果不会复活。
- 用户变化：角色立即停止当前回答。
- 协议/模型调用：复用 `control.interrupt`，不增加模型调用。
- 风险：新旧 turn 竞态、取消确认延迟。

### Stage 3：首句先说

- 做什么：Core 产生短语封口，TTS 和 OutputSegment 按段发布。
- 用户变化：不用等整段回答才开口。
- 协议：需要段级封口/发布语义；Timeline 可保持按段运行。
- 模型调用：LLM 不增加；TTS 请求可能增加。
- 风险：短语碎片化、韵律下降、动作材料不同步。

### Stage 4：回复后的余韵

- 做什么：小范围姿态/表情 residue，复用已有 offset、velocity 和衰减。
- 用户变化：说完后不突然回到无关待机。
- 协议/模型调用：不需要。
- 风险：姿态卡住或与 ambient 冲突。

### Stage 5：自动插话与风格调校

- 做什么：speech activity、跨来源 barge-in、回声验证和现有 variation/ambient 调优。
- 用户变化：不按键也能自然插话，表现更有个性。
- 协议：可能增加轻量 speech activity 事件。
- 模型调用：不增加。
- 风险：误打断和噪声抖动。

## 13. Three Experiments

### Experiment 1：即时视觉响应

最小实现：仅在 PTT 按下时播放一次本地 attention 反应，其他链路不变。

记录 PTT 到首帧、TTFA、等待感评分、错误确认次数和 plan 冲突。A/B 比较当前版本与即时反应版本。

成功标准：TTFA 基本不变，但用户等待感稳定下降，没有明显误确认或视觉冲突。失败说明反应时机、幅度或语义不清，不代表需要生命场。

### Experiment 2：首句级 TTS

最小实现：对固定双句文本先播放句 A，再准备句 B；先不接 LLM streaming。

记录每句 TTS 时间、TTFA、段间静音、完整完成时间、请求数量、韵律和自然度。A/B 比较一次完整 TTS 与分句流水线。

成功标准：TTFA 稳定改善，用户偏好提升，段间停顿和韵律损失可接受。失败说明分句或 TTS provider 不适合，不应立即建设音频 chunk 系统。

### Experiment 3：residue 与离散动作

最小实现：只对少量头部/表情参数保留短暂有界 residue 并衰减，不增加完整 continuous state。

记录动作结束到下一输入的参数变化、速度、跳变、残留时间和用户的连续性/干扰评分。A/B 比较 residue 与额外离散 idle 动作。

成功标准：residue 在动作数量不增加的情况下更连续、更有状态，且没有卡姿态或语义串扰。失败说明当前段内 residual 已足够，或 residue 选点、幅度、时长不合适。

## 14. 有限时间时的前三件事

如果目标是让用户在第一次使用的 30 秒内明显感觉“它会立即回应我、状态连续”，优先顺序是：

1. 先测量 PTT 常驻运行时的 `keydown -> first PCM`，确认它已不受设备和 AudioWorklet 冷启动影响。
2. PTT/输入事件立即驱动 attention → listening → processing。
3. PTT 按下立即停止当前回答并转入 listening。

正常说完后的短暂姿态余韵紧随其后；首句级 TTS 流水线仍是后续最重要的回复首响优化，但依赖配套 Core 的
短语封口和 TTS 行为，实施不确定性更高。
