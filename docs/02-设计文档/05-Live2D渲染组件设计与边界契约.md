# Live2D 渲染组件设计与边界契约

状态:V1 代码基线设计与后续演进边界 · 复核日期:2026-11-12 · 范围:原生侧 Live2D 运行时组件化 + TypeScript/C++ 双实现关系
性质:**边界契约与迁移方案;D3D11/Cubism、参数混音、语音随动、交互贡献、参数计划执行和增量音频路径已经进入 C++;宿主拆分已完成，完整 TypeScript 编译器等价和真实设备验收仍属后续工作。**

当前 Adapter 的 `output.segment.payload.speech` slot 固定为 `absent`；本文对 Native speech cues 的解析与渲染讨论属于协议能力/Native 设计边界，不表示当前 AG99 Persona `segments[].speech` 会作为该 slot 发送。Persona 分段与逐段动作/TTS 关联见[动作生成与 Persona 分段关联](../01-架构与结构/07-动作生成与Persona分段关联.md)。TypeScript 是持续开发实现，C++ 是冻结大版本后的高性能稳定实现。

---

## 0. 文档定位与本文不做的事

本文回答两个问题:

1. `render-core/`(C++)目前把前端业务代码翻译到了什么程度,哪里失真。
2. 一个新的 Live2D 渲染组件应该长成什么样、边界划在哪里、替换顺序如何。

本文**不做**以下决定,留给维护者裁定(见 §10):

- 下一大版本的表现规则和新增能力范围。
- 迁移是否立即启动,还是先只做组件化不做替换。

本文**遵循**仓库已有记录的方向性意图,不新增也不推翻:`render-core/README.md:83-96` 已声明
"原生宿主用于替换前端的渲染与播放运行时(而非设置应用)",且"生产宿主必须是 Adapter 的唯一
客户端,前端通过本地 IPC 桥向它发送设置与控制命令"。本文把该意图细化为可执行契约。

---

## 1. 已验证基线

以下为本次实际执行结果,非引用历史记录:

| 项 | 结果 |
|---|---|
| `cmake --build render-core/build --config Release` | 成功,产出 `ag99-render-host.exe` |
| `cmake --build runtime-core/build --config Release --target ag99-runtime-protocol-smoke` | 成功 |
| `ag99-runtime-protocol-smoke.exe` | `exit=0` |
| Cubism SDK 位置 | `C:\Users\Administrator\Downloads\CubismSdkForNative-5-r.5\CubismSdkForNative-5-r.5`(仓库不 vendor,CMake 需外部指路) |

**未验证**:所有视觉与行为质量(动作表现、口型观感、Physics 手感)。原生侧没有任何可自动化的
渲染断言,`state.yaml` 连续记录 `evidence_gap: Live native host verification is still required`。

---

## 2. 翻译覆盖盘点(结论)

结论一句话:**协议层、参数计划校验层和主要参数运行时已经进入 C++;动作编译器仍是面向稳定子集的平行实现,尚未覆盖 TypeScript 的完整 stage 与 `PerformanceSchedule` 层。**

### 2.1 已忠实翻译(可作为替换基线)

| 前端源 | C++ 对应 | 核对结论 |
|---|---|---|
| `model-engine/planParser.ts` | `render-core/src/motion_compiler.cpp:ParseParameterPlan` | 字段白名单、curve、关键帧、response、expression 和时长边界已进入 Native 参数计划解析；逐字段黄金样本仍待建立 |
| `speechsignalruntime.ts` | `render-core/src/speech_signal.cpp` | 独立口型/语音能量曲线、语音状态滞回和包络常量已进入 Native；重音输入使用 RMS 上升沿近似 |
| `parameterpresentation.ts` 轨道解析 | `render-core/src/motion_compiler.cpp:ParseParameterPlan` | 参数轨道、modulation、response 配置已进入 Native 参数计划路径 |
| `parameterpresentation.ts` bounded / spring 动力学 | `render-core/src/motion_scheduler.cpp:AdvanceBounded` / `AdvanceSpring` | 当前实现已按稳定规则收敛；逐帧数值等价仍需样本确认 |
| `lappmodel.ts` physics3.json 输出所有权 | `render-core/src/native_model.cpp:NativeCubismModel` | 输入/输出 ID 采集、受保护参数排除和响应缩放已实现 |
| `stages/semanticAxisRelationGraphStage.ts` | `render-core/src/motion_compiler.cpp:CompileMotionPlan` | 关系图传播、方向冲突和范围约束已实现于 Native 编译子集 |

### 2.2 尚未与 TypeScript 等价的部分

当前 C++ 已经具备可运行的参数运行时和稳定参数计划执行路径。下面记录的是仍未与 TypeScript 完整等价、或尚未用机器样本证明一致的部分：

| 差异项 | TypeScript 参考 | 当前 C++ 状态 |
|---|---|---|
| `parametermixer.ts` 多贡献者混音器 | 757 行 | 已有 `ApplyParameterFrame`、贡献者分组、单次 pre-Physics 写入和回读校验；TS/C++ 逐帧轨迹等价尚未用黄金样本证明 |
| 交互摇摆 + 视线跟随 | `activeparameterruntime.ts` | 已有 interaction sway/gaze 贡献路径；真实输入、打断释放和跨端轨迹仍待验收 |
| 语音随动与重音 | `speechsignalruntime.ts` / `lipSyncTimelineSink.ts` | 已恢复独立口型/语音能量曲线，并使用 RMS 上升沿生成重音；它不是 WebSDK 的 FFT 频谱输入，属于明确的表现降级 |
| `PerformanceSchedule` 与 `parameterTrackGraphCompiler.ts` | `performanceSchedule.ts` / `parameterTrackGraphCompiler.ts` | 尚未移植完整调度总线和序列轨迹合并；当前稳定路径优先消费已编译的 `engine.parameter_plan.v3` |
| semantic / parameter stages | `stages.ts` 及其 stage 实现 | `CompileMotionPlan` 是受限的原生编译子集，不是完整 TypeScript pipeline |
| 播放时钟 / turn 生命周期 | `playback-timeline/` + `turn-playback/` | 已有 native audio worker、generation、segment terminal 和中断清理；尚未与 TypeScript Timeline 做完整行为等价验证 |

### 2.3 历史失真项与当前状态

此前记录的 F-1（口型增益）、F-2（blend-in 起点）、F-3（spring 积分器）和 F-4（速度状态）已经在当前 C++ 代码中完成对应修正：独立口型/语音能量曲线位于 `render-core/src/speech_signal.cpp`，blend-in 使用 `presentation.initial_value`，spring 使用解析阻尼速度、梯形积分并携带速度状态。它们仍需要 TS/C++ 轨迹样本和真实模型观感验收，不能仅凭源码对照宣布表现等价。

仍需关注的差异：

- C++ 使用 50 Hz RMS 桶，WebSDK 使用独立的音频分析节奏；两者的时间采样不是同一实现。
- C++ 重音来自 RMS 上升沿，WebSDK 仍可使用频谱输入；两者不应被文档描述成完全等价。
- 负例拒绝、诊断 reason 顺序和复杂 sequence 轨迹仍需黄金样本固定。

### 2.4 编译器真实拓扑(修正此前的认知)

TypeScript 的完整编译拓扑是 **6 → PerformanceSchedule → 4** 三段；C++ 当前只实现其中的协议/参数计划执行和受限的 `motion_intent` 编译子集：

```
engine.motion_intent.v4
  │
  ├─ compileSemanticMotion()            compileSemanticMotion.ts:36
  │    ├─ motion_steps 存在 → compileSemanticSequence()  逐步编译后聚合
  │    └─ compileSemanticPoseContext() → runCompilePipeline(semanticStages × 6)
  │         intentValidator → axisResolver → intensity
  │         → semanticAxisRelationGraph → modeResolver → timing
  │    ⇒ CompiledSemanticMotion { kind: pose|sequence, axes[], timing, diagnostics }
  │
  ├─ compilePerformanceSchedule()       performanceSchedule.ts:141
  │    输入:assistantText, speechCues, durationMs, intentTags, sequenceSteps
  │    ⇒ PerformanceSchedule          ← 编译期与运行期【共享】的调度总线
  │
  └─ runCompilePipeline(modelParameterStages × 4)
       speechPose → modelParameterBinding → parameterTrackGraph → resourcePolicy
       (sequence 分支额外经 compileParameterSequenceTrackGraph 合并为单一计划)
    ⇒ engine.parameter_plan.v3
```

`PerformanceSchedule` 的对外接口(`performanceSchedule.ts:131-1176`)显示它并非纯编译期中间量:
`finalizePerformancePlanRelease`(`:1174`)参与**运行期释放**,`registerPerformanceParameterNodes`
(`:1140`)被 `parameterTrackGraph` stage 调用,`compileSemanticTrackTiming` / `compileGazeTrackTiming` /
`compileFaceTrackTiming` / `compileSpeechTrackTiming` / `resolveSpeechPhraseGroup` 被多个 stage 共享。
把它当"可以略过的中间步骤"是错误的。

**C++ 现状的主要依赖缺口**：`compilePerformanceSchedule` 的两个主输入是 `assistantText` 与
`speechCues`。C++ 的 `runtime-core/src/protocol.cpp` **已正确解析** speech cues（含 kind /
phrase_index / position 校验），但 `render-core/src/native_runtime_coordinator.cpp` 的
`OnSegment` 尚未把 `segment.speech.cues` 接入原生动作编译器；`AudioQueueItem` 已移入
`render-core/include/ag99/native/playback_ledger.hpp` 并保留完整 segment，当前编译路径仍只消费
动作和播放身份。**数据在协议层被正确送达，在原生表现编译层尚未使用。**
不先修这一处，`PerformanceSchedule` 层无法按 TypeScript 语义移植；这属于下一阶段编译器一致性工作，不影响当前 C++ 直接消费已编译参数计划的 V1 稳定路径。

---

## 3. 组件分层与边界契约

### 3.1 目录与目标结构

```
render-core/
  include/ag99/native/
    settings_controller.hpp  motion_compiler.hpp  motion_scheduler.hpp
    playback_ledger.hpp      audio_runtime.hpp    native_runtime_coordinator.hpp
    native_model.hpp         native_host.hpp      ...
  src/
    settings_controller.cpp  motion_compiler.cpp   motion_scheduler.cpp
    audio_runtime.cpp        native_runtime_coordinator.cpp
    native_model.cpp         native_host.cpp
    main.cpp                 # 启动装配、D3D surface 和消息循环
```

拆分的直接收益：`main.cpp` 现在只保留启动装配、D3D surface 和消息循环，窗口/托盘/输入、
音频设备与时钟、模型生命周期、动作编译和调度已经位于独立编译单元。动作编译和调度可以
脱离 GPU 与 SDK 做 smoke/golden 样本比对；跨端样本仍是 §9 验证契约的未完成部分。

### 3.2 职责边界

| 层 | 拥有 | 明确不拥有 |
|---|---|---|
| **Compiler** | 语义→计划的全部业务规则;确定性;诊断 | Cubism SDK、D3D、音频设备、墙钟、未播种随机数 |
| **ParameterRuntime** | 贡献者收集与合成、语音信号、表现动力学、**唯一一次 pre-Physics 参数写入** | 窗口、设备、协议解析、编译 |
| **Renderer Backend** | D3D11 device/context、composition swapchain、RTV、DirectComposition、透明清屏与 Present;Cubism renderer、纹理绑定、MVP 与 draw | HWND 创建、托盘、Adapter 协议、模型动作/音频业务语义 |
| **Host** | HWND、窗口输入/托盘、帧循环、模型与 Cubism Framework 生命周期;装配并调用 Renderer Backend | 图形资源内部所有权;任何参数业务语义;任何协议字段解释 |

### 3.3 层间调用契约(硬约束)

```cpp
// Compiler — 纯函数,可单测
CompileResult compile_model_parameter_plan(
    const SemanticMotionIntent& intent,      // engine.motion_intent.v4
    const SemanticAxisProfile&   profile,    // ag99.semantic_axis_profile.v3
    const CompileOptions&        options);   // assistantText / speechCues / targetDurationMs
                                              // speechActive / samplingIdentity / settings

// Runtime — 每帧一次,返回本帧写入集合
FrameResult apply_frame(ParameterRuntime&, const FrameInput&);
// FrameInput { plan, deltaSeconds, lipSync, speechSignal, interactionSway,
//              interactionGaze, lipSyncParameterIds }
// 契约:① 内部按贡献者分组叠加,禁止顺序覆盖
//       ② 返回值携带 writebackMismatch(回读校验),非空即视为运行失败

// Host — 每帧顺序固定
host.begin_frame();
runtime.apply_frame(...);      // ① 唯一一次 pre-Physics 写入
model.update_physics_and_pose(dt);
model.update();
host.draw_and_present();
```

`Physics` 之前只允许一次参数写入,是现有前端 `parametermixer.ts:203-206` 注释已确立的契约
("one response pass, one frozen Cubism base snapshot, and the final pre-Physics parameter write"),
原生侧必须继承。

---

## 4. 编译层契约

### 4.1 确定性要求(可移植性的核心)

已核实:`compiler/stages/` 全目录**无任何** `Date.now` / `performance.now` / `Math.random` /
`new Date` / `crypto` 引用。所有非确定性均为**播种确定性**,集中在两处:

- `axisResolver.ts:315-322` 私有 `seededSignedUnit`(FNV-1a)
- `performanceDeterminism.ts:9-16` `hashPerformanceIdentity` / `performanceUnitInterval`

因此编译器在给定 `(turnId, messageId, profile.source_hash, profile.revision, options, settings)`
时**逐位确定**。移植契约要求:

- **R-1** 移植后必须维持逐位确定。唯一随机源为 FNV-1a(偏移基 `0x811c9dc5`、素数 `0x01000193`、
  `>>> 0` 归一、除以 `0xffffffff` 映射到 `[-1,1)`),C++ 必须用 `uint32_t` 无符号语义实现,
  **不得**用有符号溢出或 `double` 累乘模拟。
- **R-2** `axisResolver` 的私有 `seededSignedUnit` 与 `performanceDeterminism.hashPerformanceIdentity`
  是同一算法的两份独立拷贝。移植时**必须合并为单一实现**,否则采样会静默分叉。
- **R-3** 全部时间输入以毫秒整数契约传递,禁止用 `double` 秒在层间流转(前端已在
  `at_ms` / `transition_ms` / `blend_*_ms` 上如此)。

### 4.2 跨 stage 共享常量(移植最高风险项)

以下常量在 2 个以上位置出现,字面拼写不一致,是最容易静默分叉的地方:

| # | 内容 | 出现位置 | 风险 |
|---|---|---|---|
| 1 | FNV-1a 全套常量 | `axisResolver.ts:315-322`、`performanceDeterminism.ts:9-16` | 同一算法两份拷贝 |
| 2 | 舍入精度 | `Math.round(v*10000)/10000`(`axisResolver.ts:324`)、`Math.round(v*1000000)/1000000`(`parameterTrackGraphCompiler.ts:587`) | 两种精度,不可统一 |
| 3 | 近似相等 epsilon | `1e-6`(`parameterTrackGraphCompiler` ×3)、`0.000001`(`speechPoseStage.ts:310`) | 同值两种拼写 |
| 4 | 阈值 `0.0001` | `semanticAxisRelationGraphStage.ts` ×3 | "受约束但相等"判定 |
| 5 | 中立容差 | `0.001`(`axisResolver` 全中立门)、`0.0001`(关系图) | 两个不同容差,勿合并 |
| 6 | `MIN/MAX/DEFAULT_MOTION_DURATION_MS` = 320 / 15000 / 1000 | `constants.ts` → `timing` | C++ 参数计划解析已使用 320/15000；原生 `motion_intent` 子集仍使用独立的 250/5000 窗口，必须作为能力边界固定并纳入样本 |
| 7 | `MIN/MAX_PARAMETER_KEYFRAME_COUNT` = 2 / 4 | `constants.ts` → `parameterTrackGraphStage` | C++ 参数计划与 motion intent 子集的限制不同，需由黄金样本固定拒绝行为 |

### 4.3 十个 stage 契约

执行顺序是编译器契约的一部分(`stages.ts:14` 注释),必须原样保持。

**语义组(6)**

| # | id | 读 | 写 | 失败 reason | 纯度 | 行数 |
|---|---|---|---|---|---|---|
| 1 | `intentValidator` | `intent.{profile_revision,profile_id,model_id,emotion_label,schema_version,axis_levels}`、`options.model.semantic_axis_profile`、`options.speechActive` | `state.profile`、`state.axisById` | `semantic_profile_missing`、`semantic_axis_dynamics_invalid:{axis}`、`semantic_profile_id_mismatch:{id}`、`semantic_profile_model_mismatch:{id}`、`emotion_label_empty`、`motion_sequence_must_compile_at_root`、`semantic_intent_axes_empty`、`semantic_profile_revision_mismatch:{intent}:{profile}` | 纯 | 100 |
| 2 | `axisResolver` | `state.profile`、`axisById`、`intent.axis_levels`、`options.samplingIdentity`、`options.allowNeutralAxisPose` | `roleAxisIds`、`controlledValues`+`axisValueSources`、`forbiddenAxes`、`invalidAxes`、`warnings`、`axisSampling` | `semantic_profile_missing`、`semantic_axis_sampling_identity_missing`、`semantic_axis_sampling_profile_hash_missing`、`semantic_axis_validation_failed:{axes}`、`semantic_axes_all_neutral` | **播种随机**(私有 FNV-1a) | 341 |
| 3 | `intensity` | `controlledValues`、`axisById`、`intent.mode`、`settings.motionIntensityScale` | `controlledValues`、`axisValueSources`、`allAxisValues` | 无 | 纯 | 69 |
| 4 | `semanticAxisRelationGraph` | `profile`、`axisById`、`controlledValues`、`derivedValues` | `controlledValues`、`derivedValues`、`axisValueSources`、`appliedDerivedAxes`、`relationAdjustments`、`relationEvaluations`、`warnings`、`allAxisValues` | `semantic_profile_missing`、`semantic_axis_relation_resolution_exhausted`、`semantic_axis_relation_axis_missing:{rule}`、`semantic_axis_relation_axis_missing:range:{axis}` | 纯 | 495 |
| 5 | `modeResolver` | `allAxisValues`、`axisById`、`warnings`、`intent.mode` | `resolvedMode`、`warnings` | 无 | 纯 | 69 |
| 6 | `timing` | `resolvedMode`、`intent.{duration_hint_ms,performance_curve_hint}`、`options.{targetDurationMs,speechActive}`、`warnings` | `timing`、`warnings` | 无 | 纯(委派 `model-engine/timing.ts`) | 46 |

**参数组(4)**

| # | id | 读 | 写 | 失败 reason | 纯度 | 行数 |
|---|---|---|---|---|---|---|
| 7 | `speechPose` | `options.{speechActive,samplingIdentity}`、`profile`、`axisById`、`pendingSpeechGestures`、`options.model.voice_following_profile`、`performanceSchedule.{durationMs,phrases,textSource}`、`semanticMotion.{performanceCurveHint,emotionLabel,intentTags,axes}` | `pendingSpeechGestures`、`warnings` | `semantic_profile_missing`、`speech_gesture_channel_invalid:{chs}`、`speech_gesture_semantic_binding_mismatch:{m}`、`speech_gesture_timing_missing`、`speech_gesture_channels_unavailable:{preset}`、`speech_gesture_axis_duplicate:{axis}`、`speech_gesture_phrase_event_invalid:{id}` + `compileSpeechTrackTiming` 原样透传 | **播种随机**(`performanceDeterminism`) | 424 |
| 8 | `modelParameterBinding` | `profile`、`axisById`、`pendingSpeechGestures`、`parameters`、`semanticMotion.axes` | `parameters`、`warnings` | `semantic_profile_missing`、`unknown_axis:{axis}`、`axis_parameter_binding_missing:{axis}`、`duplicate_parameter_binding:{pid}`、`parameter_binding_parameters_empty` + `semanticParameterBinding.ts` 的 `binding_input_range_zero` / `binding_weight_invalid` / `binding_input_value_out_of_range` / `binding_target_not_finite`(均带 `:{axis}:{param}` 后缀) | 纯 | 137 |
| 9 | `parameterTrackGraph` | `parameters`、`pendingSpeechGestures`、`profile.axes`、`performanceSchedule`、`semanticMotion.timing.timing.blend_out_ms` | 原地深改 `parameters[n].modulation` / `.keyframes`;`performanceSchedule`(节点注册);`warnings` | `parameter_track_graph_speech_binding_missing:{axis}`、`..._modulation_conflict:{pid}`、`..._keyframe_conflict:{pid}`、`..._{strategy}_points_missing:{pid}` + `compileGazeTrackTiming` / `compileFaceTrackTiming` / `registerPerformanceParameterNodes` / `buildStagedPartParameterTrack` 原样透传 | 经 `performanceSchedule.ts` 间接依赖 `performanceDeterminism` | 195 |
| 10 | `resourcePolicy` | `semanticMotion.expressionResourceId`、`options.model`、`parameters` | `expressionResource` | `expression_resource_resolution_type_invalid` + `resourceCatalog.ts` 的 `resource_id_empty`、`resource_not_found:{id}`、`resource_ambiguous:{id}`、`expression_runtime_ownership_invalid:{id}` | 纯(大小写不敏感,要求唯一命中) | 50 |

**依赖序(语义组完全串行,声明序即最小串行序)**

```
intentValidator → axisResolver → intensity → semanticAxisRelationGraph
  → modeResolver → timing
```

关键约束:`axisResolver` 调用的 `replaceControlledAxisValues` **不**刷新 `allAxisValues`,
首次 `refreshAllAxisValues` 发生在 `intensity`。因此 `modeResolver` 确实要求排在第 4 位或之后。
`intensityStage` 注释("Range constraints belong to the relation graph stage")确认
`intensity` 必须先于关系图 stage。

**参数组**

```
speechPose → modelParameterBinding → parameterTrackGraph → resourcePolicy
```

`resourcePolicyStage` 头部注释声明其冲突检查"belongs after parameter binding"。
已知非最小性:`resourcePolicy` 只读 `parameters[].parameter_id` 与 `options.model`,而
`parameterTrackGraph` 只改 `modulation` / `keyframes`、从不增删改 `parameter_id`,故
`resourcePolicy` 实际可紧跟 `modelParameterBinding` —— 声明序比数据依赖更严。这不是矛盾,
移植时可保留原序以免行为漂移,但应在契约中记录。

**未穷尽项(诚实标注)**:`compileSpeechTrackTiming` / `resolveSpeechPhraseGroup` /
`compileGazeTrackTiming` / `compileFaceTrackTiming` / `registerPerformanceParameterNodes` /
`resolvePerformancePartTrackStrategy` 位于 `performanceSchedule.ts`(1713 行),本轮未逐行取证。
`speechPose` 与 `parameterTrackGraph` 会**原样透传**这些 helper 的 reason,因此上表 7 / 9 的
reason 集合并不完整。移植该层前必须补齐这批 helper 的契约。

---

## 5. 参数运行时契约

### 5.1 贡献者模型(替换顺序单写者)

```
ParameterContributionOwner = interaction_sway | interaction_gaze | direct_plan | lip_sync
```

每帧算法(对应 `parametermixer.ts:207-301`):

1. 无任何活跃来源且无口型源 → 早退,不重建贡献图与 base snapshot(性能契约)。
2. 按贡献者分别收集 contribution。
3. 按 `parameterIndex` 分组;组内 `parameterIdRaw` 不一致 → 失败 `parameter_mixer_parameter_identity_conflict`。
4. 采集**冻结的** Cubism base snapshot。
5. 合成 → 一次 response pass。
6. 逐参数写入并**回读校验**,偏差 > 0.001 → 失败 `parameter_mixer_write_mismatch:{id}`。

C++ 当前已经采用该模型。`UpdateAndDraw` 先更新动作和音频信号，再调用 `ApplyParameterFrame`，
由贡献者模型完成一次参数解析、写入和回读校验，随后才进入 Physics 与 Cubism update。
旧的“每个来源独立 `SetParameterValue`、后写覆盖”描述属于历史审计结论，不再代表当前代码。

### 5.2 语音信号契约

当前 C++ 已实现独立口型曲线、语音能量曲线、语音状态滞回和 RMS 上升沿重音包络。与 WebSDK 的差异必须显式记录:

| 信号 | 前端来源 | 当前 C++ |
|---|---|---|
| `lipSyncIntensity` | `(rms - 0.012) * 30` 钳位 | 已采用同一曲线 |
| `speechEnergyValue` | `(rms - 0.008) * 5.5` 钳位 | 已采用独立曲线 |
| `speechEmphasisValue` | `getByteFrequencyData` 频谱 | 使用 RMS 上升沿近似，不等价于 FFT，需保留为表现降级和验收项 |

桌面语音音量 `speech_volume` 由 Adapter 的统一配置源提供，Native 在当前 WAV 和 OLV
waveOut 输出上应用同一倍率；它不改变 RMS/lip-sync 分析输入。

采样率:前端为 30 Hz(`state.yaml:frontend_runtime_occupancy_followup` 记录 60 FPS 渲染 +
30 Hz 分析);C++ 现状为 WAV RMS 50 Hz 分桶(`render-core/src/audio_runtime.cpp:106-109`)。两者都必须显式声明并
在契约中固定,不得隐式漂移。

### 5.3 表现动力学契约

- **P-1** blend-in 起点使用 presentation 节点创建时的实时值(`initialValue`)，当前 C++ 已实现。
- **P-2** spring 使用解析阻尼速度、梯形积分、逐步 settle 和“先加速度限、再 `±maxVelocity`”的顺序，当前 C++ 已实现。
- **P-3** 速度作为节点状态携带并在 settle 时归零，当前 C++ 已实现；仍需轨迹样本确认跨端数值一致。
- **P-4** bounded 动力学现有 C++ 实现已正确,保留。

---

## 6. 宿主层契约

- 窗口 / 托盘 / 输入控件和窗口消息由 `NativeHost` 持有；D3D11 surface 仍由 `main.cpp` 在启动阶段装配。
- 音频设备、PCM 队列、音频时钟和播放终态由 `AudioRuntime` 持有，不改单一时钟和 receipt 行为。
- `NativePlaybackRuntime` 只负责消费 `AudioRuntime` work batch、完整段/OLV 播放和
  播放终态回调；`NativeInputRuntime` 只负责麦克风采集与设备生命周期；
  `NativeTransport` 只封装 WebSocket 连接端口。三者不直接写 Cubism 参数。
- 帧循环顺序固定为 §3.3 的五步。
- `delta_seconds` 钳制上限保持 `0.1`，由 Native 帧循环统一执行。
- 宿主**不得**解释任何协议字段,只消费已解析的结构体。

---

## 7. 协议与 Schema 权威契约

### 7.1 当前状态

`astrbot_plugin_ag99live_adapter/protocol/schema_manifest.json` 是版本唯一权威，共 10 个 schema，`protocol_version = v2`：

```
model_info = live2d_scan.v4                    motion_intent = engine.motion_intent.v4
motion_tuning_sample = ag99.motion_tuning_sample.v2
output_segment = output.segment.v6              parameter_plan = engine.parameter_plan.v3
parameter_action_library = parameter_action_library.v2
performance_curve_hint = ag99.performance_curve_hint.v1
semantic_axis_profile = ag99.semantic_axis_profile.v3
semantic_axis_relation_graph = ag99.semantic_axis_relation_graph.v1
voice_following_profile = ag99.voice_following_profile.v3
```

runtime-core 的 Native 头文件已经由 CMake 从 manifest 生成，`check_protocol_schema_manifest.py` 会同时核对 manifest、TypeScript 生成文件和 C++ 头文件。当前仍没有 CI 自动执行这项检查，因此构建前仍需显式运行脚本。

### 7.2 仍需收口的协议边界

| 项 | 当前状态 |
|---|---|
| S-1：从 manifest 生成 C++ schema 常量 | 已完成，见 runtime-core CMake 和生成头文件 |
| S-2：C++ 使用完整 schema 结构体校验 | 部分完成；协议核心覆盖主要输出与动作 schema，模型 Profile 仍有临时 JSON 遍历 |
| S-3：`SetModelSync` 使用经校验的结构体 | 尚未完成；当前仍从 `model_info` 临时 JSON 读取 Profile 绑定 |
| S-4：`OnSegment` 透传 `text.content` 与 `speech.cues` | 文本已用于诊断和播放身份，`speech.cues` 仍未进入原生动作编译路径 |

## 8. 替换策略(不留兼容层)

遵循 `.ai/index.md` "Replacement Over Compatibility"。每一步**同一次改动内**完成
"引入新路径 + 删除旧路径",不允许任何步骤留下双实现。

| 步 | 动作 | 同步删除 |
|---|---|---|
| R-1 | 建立 schema 生成步骤,`protocol.hpp` 改为生成头 | 已完成 |
| R-2 | 修 `OnSegment` 文本 / speech cues 丢弃 | 文本已接入；`speech.cues` 仍待进入原生编译器 |
| R-3 | 抽出 `compiler/` 纯函数库 + 黄金样本比对通过 | 已拆出 `motion_compiler.cpp` / `motion_scheduler.cpp`；TS/C++ 黄金样本仍待完成 |
| R-4 | 用 `compiler/` 替换 `CompileMotionPlan` | 部分完成：`CompileMotionPlan` 已移入 `motion_compiler.cpp`；完整 TS 编译器契约仍待完成 |
| R-5 | 引入 `runtime/mixer`,改为贡献者模型 + 单次 pre-Physics 写入 | 已完成当前运行时路径 |
| R-6 | 修 F-1~F-4 与 §2.4 次要校验项 | F-1~F-4 已在代码中修正；跨端轨迹和负例 reason 仍待验证 |
| R-7 | 抽出 `host/` | 已完成，窗口、托盘、输入控件和窗口消息已移入 `native_host.cpp`；D3D surface 保留在启动装配 |
| R-8 | 接入 interaction sway / gaze 事件 | 已有原生贡献路径；真实设备和跨端行为仍待验收 |
| R-9 | 依 §10 的双轨决策保留各自实现；只有未来明确替换产品 owner 时才评估删除 | V1 不删除 TS `model-engine/compiler/`，也不删除 C++ 稳定运行时 |

**禁止事项**(直接违反 `.ai/index.md`):

- 不得引入 feature flag 让新旧两条参数写入路径并存。
- 不得为旧调用方保留 wrapper 或适配层。
- 不得新增第二条 Adapter 连接或第二个播放时钟。

---

## 9. 验证契约

替换的正确性不能靠肉眼。必须建立机器可判定的等价性证明。

### 9.1 编译期黄金样本

- **V-1** 建立语料库:一组 `engine.motion_intent.v4` 输入(含 pose 与 sequence 两类、
  含各 `curve_preset`、含 spring 与 bounded 两种 response、含 expression 资源、
  含 speech cues 与无 speech 两条路径),连同**由现役 TS 实现产出的**期望
  `engine.parameter_plan.v3`。
- **V-2** 断言:同一输入下 C++ 产出与期望**逐字段相同**(含 diagnostics.warnings 顺序)。
- **V-3** 负例语料:`duration_weight` 越界、重复 `parameter_id`、keyframe 越界、
  spring 参数越界、expression 与参数冲突 —— 断言**拒绝行为与 reason 字符串**两侧一致。
  (此项直接修补 `docs/codebase-audit.md` P0-2 记录的双 owner 无校验缺口。)

### 9.2 运行期轨迹比对

- **V-4** 固定 delta 序列(如 1/60 s × 600 帧)与固定音频信号序列,分别驱动 TS 与 C++ 运行时,
  逐帧导出被写入的参数值,断言最大偏差 ≤ 1e-4。
- **V-5** 覆盖四类贡献者同时活跃的帧(plan + lip sync + sway + gaze 命中同一参数),
  这是当前 C++ 必然失败、修复后必须通过的用例。

### 9.3 边界校验

- **V-6** 保持现有最小检查:`ag99-runtime-protocol-smoke` 一个成功用例 + 一个拒绝用例。
  按 `.ai/index.md` 测试策略,不铺开回归矩阵。

### 9.4 仍需真实运行的部分

以下**无法**由上述自动检查覆盖,必须在报告中显式声明为 `evidence_gap`,不得用更多 mock 补偿:
动作表现质量、口型观感、Physics 手感、Spout/OBS 输出、透明边缘。

---

## 10. 未决决策(需维护者裁定)

| # | 决策 | 选项 | 影响 |
|---|---|---|---|
| D-1 | TypeScript/C++ 运行时关系 | TypeScript 作为持续开发和表现迭代实现；C++ 作为冻结大版本后的高性能稳定实现；两者共享协议、Profile、编译规则和黄金样本 | V1 采用双轨实现，一次运行只选择一个实现，不要求 C++ 跟随每次 TypeScript 提交同步 |
| D-2 | Motion Lab / Action Lab 的编译器依赖 | 开发工具继续使用 TypeScript 编译器；C++ 在稳定大版本冻结时按同一契约移植并通过黄金样本验证 | 工具链保持快速迭代，稳定身体运行时保持高性能和版本边界 |
| D-3 | 是否立即启动 R-3~R-8,还是先只做组件化 | 先完成文档、黄金样本和真实验收证据，再决定编译器迁移批次 | 当前基线先冻结代码与版本，不把新的表现能力并入 V1 |
| D-4 | `performanceSchedule.ts` 六个 helper 的契约补齐由谁承担 | — | 阻塞 §4.3 中 stage 7 / 9 的完整 reason 集合 |
| D-5 | 频谱重音分析在原生侧的实现或显式降级 | (a) 实现 FFT 重音;(b) 声明 RMS 上升沿降级并记 `evidence_gap` | 决定 TS/C++ 语音重音的等价度 |

**V1 结论**:TypeScript 与 C++ 采用双轨版本关系。TypeScript 负责下一版本的持续迭代，C++ 负责已冻结大版本的稳定运行。两者通过协议、编译规则、能力清单和黄金样本保持可验证的一致性；不在同一次运行中并行写入同一身体。当前下一步先补齐文档和验证证据，再决定是否启动完整编译器迁移。

---

## 11. 风险登记

| 风险 | 等级 | 说明 | 缓解 |
|---|---|---|---|
| 编译器移植面远大于预期 | 高 | 10 个 stage 1842 行 + `PerformanceSchedule` 2332 行 + `parameterTrackGraphCompiler` 633 行 ≈ **4800 行**业务规则,任一处常量分叉都静默改变表现 | V-1/V-2/V-3 黄金样本先行,R-3 与 R-4 之间不得插入其他改动 |
| §4.3 reason 集合不完整 | 高 | stage 7 / 9 透传 `performanceSchedule.ts` 六个未取证 helper 的 reason | D-4 前置补齐,否则负例语料无法覆盖 |
| 迁移期两套运行时并存 | 高 | Adapter 当前只允许一个 WebSocket 客户端(`render-core/README.md:91-96`),前端与原生同时直连会争抢会话 | 生产形态必须经本地 IPC 桥;R-3~R-8 期间不得让两者同时连 Adapter |
| 无法自动验证视觉质量 | 中 | 原生侧无渲染断言 | 已在 §9.4 显式声明为 `evidence_gap` |
| schema 漂移复发 | 中 | 现无 CI；脚本已经覆盖 manifest、TS 生成文件和 C++ 生成头，但仍需显式执行 | 将检查纳入 CI 或发布前检查 |
| 单编译单元腐化 | 低 | `main.cpp` 已收缩为启动装配、D3D surface 和消息循环 | 继续保持 NativeHost、AudioRuntime、NativeModel 和 Coordinator 的边界 |
| 现有 C++ 成果被误弃 | 低 | 参数混音、语音随动、交互贡献和参数计划执行已经是 V1 稳定路径 | R-3/R-4 复用运行时，不重写已验证路径 |

---

## 附:证据索引

| 结论 | 证据 |
|---|---|
| 翻译到位项 | `ParseParameterPlan`、`render-core/src/speech_signal.cpp`、`NativeCubismModel`、`AdvanceBounded` / `AdvanceSpring`、`CompileMotionPlan` |
| F-1~F-4 历史失真项 | `render-core/src/speech_signal.cpp`、`render-core/src/native_model.cpp` |
| 参数混音与回读 | `parametermixer.ts:207-301` ↔ `render-core/src/native_model.cpp:ApplyParameterFrame` |
| sway / gaze | `activeparameterruntime.ts:47-69` ↔ `render-core/src/native_model.cpp` |
| RMS 重音降级 | `lipSyncTimelineSink.ts:191-194`、`speechsignalruntime.ts:208-213` ↔ `render-core/src/speech_signal.cpp` |
| speech cues 仍未进入原生编译器 | `runtime-core/src/protocol.cpp`(已解析)↔ `render-core/src/native_runtime_coordinator.cpp:OnSegment` |
| 编译器拓扑 | `stages.ts:15-29`、`compileSemanticMotion.ts:36-130`、`compileModelParameterPlan.ts:26-60`、`performanceSchedule.ts:131-1176` |
| schema 生成与检查 | `schema_manifest.json`、`protocol_manifest.hpp`、`scripts/check_protocol_schema_manifest.py` |
| 双 owner(仓库既有结论) | `docs/codebase-audit.md` P0-1 / P0-2 |
| 迁移方向(仓库既有记录) | `render-core/README.md:83-96` |
