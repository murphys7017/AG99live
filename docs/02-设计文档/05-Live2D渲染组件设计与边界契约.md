# Live2D 渲染组件设计与边界契约

状态:设计草案(D3D11 图形后端首片已实现,待视觉验收) · 编写日期:2026-10-01 · 范围:原生侧 Live2D 运行时组件化 + 动作编译器归属
性质:**边界契约与迁移方案;目前仅 D3D11 透明合成 surface 与 Cubism 绘制器已实现,其余运行时迁移仍属设计。**

---

## 0. 文档定位与本文不做的事

本文回答两个问题:

1. `render-core/`(C++)目前把前端业务代码翻译到了什么程度,哪里失真。
2. 一个新的 Live2D 渲染组件应该长成什么样、边界划在哪里、替换顺序如何。

本文**不做**以下决定,留给维护者裁定(见 §10):

- 最终由哪一侧运行时(Tauri/Electron 前端 vs 原生 C++)持有权威编译器。
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

结论一句话:**协议层与参数计划校验层翻译到位;"让角色活着"的参数运行时只翻译了约三分之一;
动作编译器不是翻译而是平行重写,且漏掉了夹在两组 stage 之间的整个 `PerformanceSchedule` 层。**

### 2.1 已忠实翻译(可作为替换基线)

| 前端源 | C++ 对应 | 核对结论 |
|---|---|---|
| `model-engine/planParser.ts` (650行) | `render-core/src/main.cpp:1744-2049` | 字段白名单、5 种 curve、关键帧单调性、`at+transition ≤ duration`、spring 边界 `(0,10]` / `[0.5,1)`、weight `[0,1]`、expression 冲突拒绝、时长 `320–15000` 全部一致 |
| `speechsignalruntime.ts:18-38,242-267` | `main.cpp:89-207` | 16 个常量逐一吻合;`advanceEnvelope` 数学一致;`voice_following.` / `body_` / `pitch` 分支一致 |
| `parameterpresentation.ts:81-106` 轨道解析 | `main.cpp:2051-2073` | 一致 |
| `parameterpresentation.ts:193-228` bounded 动力学 | `main.cpp:2079-2109` | 制动速度、钳制顺序、越界吸附一致 |
| `lappmodel.ts` physics3.json 输出所有权 | `main.cpp:618-649,828-858` | 一致(输入/输出 ID 采集 + 受保护参数排除 + 响应缩放) |
| `stages/semanticAxisRelationGraphStage.ts` | `main.cpp:2426-2552` | 关系图不动点传播、`derive` / `bounded_ratio`、方向冲突减半、`hardCap` 公式一致 |

### 2.2 完全缺失

| 缺失项 | 前端规模 | 后果 |
|---|---|---|
| `parametermixer.ts` 多贡献者混音器 | 757 行 | C++ 是**顺序单写者后写覆盖**。计划与口型命中同一参数时口型吃掉计划贡献;`AddNormalizedParameterValue`(拖拽)从 `default_value` 重算,会抹掉同参数上的计划值。无 `parameter_mixer_write_mismatch` 回读校验 |
| 交互摇摆 + 视线跟随 | `activeparameterruntime.ts:47-69` | Adapter 的 "thinking" 状态在原生侧**无任何视觉表现**;只有裸窗口拖拽 |
| 频谱重音通道 | `lipSyncTimelineSink.ts:191-194` | 前端从 `getByteFrequencyData` 算 `speechEmphasisValue`,`speechsignalruntime.ts:208-213` 以 `max(包络重音, 重音×0.22)` 混入。C++ 无 FFT、无重音输入 → 重音驱动的手势调制系统性偏弱 |
| `PerformanceSchedule` 层 | `performanceSchedule.ts` 1713 + `performanceScheduleText.ts` 370 + `performanceComposition.ts` 231 + `performanceDeterminism.ts` 18 ≈ **2332 行** | 见 §2.4,这是最大的单块缺口 |
| `parameterTrackGraphCompiler.ts` | 633 行 | 序列步骤合并为单一计划的逻辑缺失 |
| 6 个语义 stage 中的 5 个 | `axisResolver` 341 / `intensity` 69 / `modeResolver` 69 / `timing` 46 / `intentValidator` 100 | 仅 `semanticAxisRelationGraph` 被翻译 |
| 4 个参数 stage 全部 | `speechPose` 424 / `modelParameterBinding` 137 / `parameterTrackGraph` 195 / `resourcePolicy` 50 | 全部缺失 |
| 播放时钟 / turn 生命周期 | `playback-timeline/` 3433 + `turn-playback/` 1519 | C++ `AudioWorkerLoop`(`main.cpp:1252-1294`)是朴素 FIFO,靠 `NowSeconds() + wav 时长` 墙钟估时发 `playback_finished`,无中断/排序协调 |

### 2.3 真实失真(4 项,按影响排序)

**F-1 口型弱约 7 倍且无噪声门**

```
前端 lipSyncTimelineSink.ts:189-190
  lipSyncIntensity = clamp01((rms - 0.012) * 30)     // 独立曲线
  speechEnergyValue = clamp01((rms - 0.008) * 5.5)    // 独立曲线
C++ main.cpp:137
  level = clamp(rms * 4.0, 0, 1)                      // 单一曲线,同时喂口型与语音能量
```

TTS 典型 `rms ≈ 0.08` 时:前端口型饱和到 `1.0`,C++ 仅 `0.32` → 嘴基本不动。两条曲线的
增益与噪底都不同,C++ 用一个值兼两职是两个错误叠加。

**F-2 blend-in 起点取错值**

前端从 `node.initialValue`(presentation 节点创建时的实时值)插值
(`parameterpresentation.ts:118-133`);C++ 从 `binding.neutral_target_value`(计划申报中立值)
插值(`main.cpp:2150-2162`)。只要实时值 ≠ 申报中立值(在上一次 motion / Physics / breath
之后几乎总是成立),`slow_build_quick_release` 与 `pulse_settle` 首帧跳变。

**F-3 spring 积分器换成了另一个算法**

| | 前端 `parameterpresentation.ts:230-333` | C++ `main.cpp:2111-2142` |
|---|---|---|
| 速度 | **解析解** `resolveDampedSpringVelocity`:阻尼频率 `ω√(1-ζ²)`、衰减 `e^{-ζωΔt}`、cos/sin 相位 | **半隐式欧拉** `a = -2ζωv - ω²x` |
| 积分 | **梯形** `(v_prev + v_next)/2 · Δt` | 显式 `value += v_next · Δt` |
| settle | **每步**判定 | 仅末尾判定 |
| 钳制顺序 | 先加速度限、再 `±maxVelocity` | 先 `±maxVelocity`、再加速度限 |

过冲形态与收敛时间都不同。这不是翻译精度问题,是换了一种物理模型。

**F-4 速度被有限差分反推,摧毁振荡状态**

前端把解析速度存在节点里、settle 时归零;C++ `main.cpp:2249-2250` 用
`velocity = (next_offset - previous_offset) / dt` 重算。对 spring 而言这抹掉了让振荡成立的
二阶状态,退化为临界阻尼趋近;且 settle 后速度非零。

**次要(校验放宽,不阻塞但应在替换时一并收紧)**

- 空 / 缺失 `profile_id`、`model_id` 不再拒绝:前端 `planParser.ts:336` 要求两者非空;
  C++ `main.cpp:1762-1763` 仅在不非空时校验**不匹配**。
- modulation 点值不校验 `[-1,1]`:前端 `planParser.ts:524-525` 校验;C++ `ParseTrackPoint`
  (`main.cpp:1730`) 只校验有限性。
- voiced 退出用 `>=` 而非 `>`:前端 `speechsignalruntime.ts:175` 用严格大于;`main.cpp:144-145`
  用 `>=`。测度为零,但属无谓偏离。

### 2.4 编译器真实拓扑(修正此前的认知)

C++ 侧与前端都不是"单条流水线",而是 **6 → PerformanceSchedule → 4** 三段:

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

**C++ 现状的致命依赖缺口**:`compilePerformanceSchedule` 的两个主输入是 `assistantText` 与
`speechCues`。C++ 的 `protocol.cpp:226-264` **已正确解析** speech cues(含 kind / phrase_index /
position 校验),但 `main.cpp:1214-1250` 的 `OnSegment` 把 `segment.text.content` 只打到 stdout、
`segment.speech.cues` **完全未读**,`AudioQueueItem`(`main.cpp:1207-1212`)只携带
`url` / `turn_id` / `motion_payload`。**数据在协议层被正确送达,在宿主层被丢弃。**
不先修这一处,`PerformanceSchedule` 层无从移植。

---

## 3. 组件分层与边界契约

### 3.1 目录与目标结构

```
render-core/
  include/ag99/live2d/
    compiler/            # 编译期:纯函数,零 Cubism / 零 D3D / 零音频 / 零墙钟
      types.hpp          profile.hpp      schedule.hpp
      pipeline.hpp       plan.hpp         diagnostics.hpp
    runtime/             # 运行时:依赖 Cubism 模型句柄,不依赖窗口
      contribution.hpp   mixer.hpp        speech_signal.hpp
      presentation.hpp   parameter_runtime.hpp
    host/                # 宿主:D3D11 / DirectComposition / 窗口 / 帧循环
      device.hpp         window.hpp       render_host.hpp
  src/{compiler,runtime,host}/...
  src/main.cpp           # 只做装配:解析参数 → 构造三层 → 跑帧循环
```

拆分的直接收益:`main.cpp` 现状 3311 行单编译单元,内含窗口/托盘/D3D11/DirectComposition/
WAV 解码/麦克风/协议/两套编译器,`CompileMotionPlan` 是 400 行、6 层嵌套。编译器一旦成为
独立纯函数库,即可脱离 GPU 与 SDK 做黄金样本比对——这是 §9 验证契约的前提。

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
| 6 | `MIN/MAX/DEFAULT_MOTION_DURATION_MS` = 320 / 15000 / 1000 | `constants.ts` → `timing` | C++ 已在 `main.cpp:1795` 硬编码 320/15000,需补 DEFAULT |
| 7 | `MIN/MAX_PARAMETER_KEYFRAME_COUNT` = 2 / 4 | `constants.ts` → `parameterTrackGraphStage` | C++ 已在 `main.cpp:1943-1944` 硬编码,一致 |

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

C++ 现状的 `UpdateAndDraw`(`main.cpp:1480-1524`)必须替换为该模型。当前它是:
`UpdateMotion` → `ApplyQueuedMotion` → `ApplyDrag` → `UpdateAudioLevel` →
`ApplyQueuedParameterPlan` → `ApplyLipSync` → `UpdatePhysicsAndPose`,每步各自
`SetParameterValue`,后写覆盖。

### 5.2 语音信号契约

保留 C++ 已翻译正确的部分(常量、包络数学、增益公式),**替换**信号来源:

| 信号 | 前端来源 | C++ 必须改为 |
|---|---|---|
| `lipSyncIntensity` | `(rms - 0.012) * 30` 钳位 | 采纳前端曲线,替换 `rms * 4.0` |
| `speechEnergyValue` | `(rms - 0.008) * 5.5` 钳位 | 独立曲线,不得与口型共用一个值 |
| `speechEmphasisValue` | `getByteFrequencyData` 频谱 | 需实现频谱重音分析,或**显式声明降级**并记录 `evidence_gap` |

采样率:前端为 30 Hz(`state.yaml:frontend_runtime_occupancy_followup` 记录 60 FPS 渲染 +
30 Hz 分析);C++ 现状为 WAV RMS 50 Hz 分桶(`main.cpp:373-374`)。两者都必须显式声明并
在契约中固定,不得隐式漂移。

### 5.3 表现动力学契约

- **P-1** blend-in 起点必须是 presentation 节点创建时的实时值(`initialValue`),**不得**用
  计划申报的 `neutral_target_value`。修正 `main.cpp:2150-2162`。
- **P-2** spring 必须移植**解析阻尼解**,不得用欧拉近似;积分用梯形 `(v_prev+v_next)/2·Δt`;
  settle 判定**每步**执行;钳制顺序为"先加速度限、再 `±maxVelocity`"。
- **P-3** 速度必须作为节点状态**携带**,settle 时归零;**禁止**用有限差分重算。
- **P-4** bounded 动力学现有 C++ 实现已正确,保留。

---

## 6. 宿主层契约

- 设备 / 交换链 / DirectComposition / 窗口 / 托盘 / 帧循环从 `main.cpp` 迁出,不改行为。
- 帧循环顺序固定为 §3.3 的五步。
- `delta_seconds` 钳制上限保持 `0.1`(`main.cpp:1487-1490`)。
- 宿主**不得**解释任何协议字段,只消费已解析的结构体。

---

## 7. 协议与 Schema 权威契约

### 7.1 现状缺陷

`astrbot_plugin_ag99live_adapter/protocol/schema_manifest.json` 是版本唯一权威,共 10 个
schema + `protocol_version = v2`:

```
model_info = live2d_scan.v4                    motion_intent = engine.motion_intent.v4
motion_tuning_sample = ag99.motion_tuning_sample.v2
output_segment = output.segment.v5              parameter_plan = engine.parameter_plan.v3
parameter_action_library = parameter_action_library.v2
performance_curve_hint = ag99.performance_curve_hint.v1
semantic_axis_profile = ag99.semantic_axis_profile.v3
semantic_axis_relation_graph = ag99.semantic_axis_relation_graph.v1
voice_following_profile = ag99.voice_following_profile.v3
```

C++ `runtime-core/include/ag99/runtime/protocol.hpp:18-21` 硬编码其中 4 个,**缺 6 个**。
`scripts/check_protocol_schema_manifest.py` 只校验 manifest ↔ TS 生成文件,不读任何
`.cpp` / `.py`。仓库无 CI(`.github/workflows` 零匹配)。后果:改 manifest 版本号时
Python 与 TS 侧静默通过,C++ 在真实桌面运行才抛 `ProtocolError`。

### 7.2 契约要求

- **S-1** C++ schema 常量必须由 `schema_manifest.json` **生成**,纳入
  `runtime-core/CMakeLists.txt` 构建步骤。方向是"派生",不是"两处手工同步"。
- **S-2** 移植编译器后,C++ 必须校验这 6 个当前缺失的 schema:
  `semantic_axis_profile.v3`、`semantic_axis_relation_graph.v1`、
  `voice_following_profile.v3`、`performance_curve_hint.v1`、
  `parameter_action_library.v2`、`motion_tuning_sample.v2`。
- **S-3** 现状 `SetModelSync`(`main.cpp:1526-1577`)以**临时 JSON 遍历**方式读取
  `model_info.models[].semantic_axis_profile.axes[].parameter_bindings[].parameter_id`,
  **无任何 schema 版本校验**。必须替换为经 S-2 校验的结构体。
- **S-4** `OnSegment` 必须把 `text.content` 与 `speech.cues` **透传至编译器**
  (见 §2.4),不得再只打 stdout。

---

## 8. 替换策略(不留兼容层)

遵循 `.ai/index.md` "Replacement Over Compatibility"。每一步**同一次改动内**完成
"引入新路径 + 删除旧路径",不允许任何步骤留下双实现。

| 步 | 动作 | 同步删除 |
|---|---|---|
| R-1 | 建立 schema 生成步骤,`protocol.hpp` 改为生成头 | 手写的 4 个 `inline constexpr` 字面量 |
| R-2 | 修 `OnSegment` 文本 / speech cues 丢弃 | stdout 打印分支 |
| R-3 | 抽出 `compiler/` 纯函数库 + 黄金样本比对通过 | 无(此时 `CompileMotionPlan` 尚在,但标记为待删) |
| R-4 | 用 `compiler/` 替换 `CompileMotionPlan` | `main.cpp:2309-2807` 全部(`CompileMotionPlan` + `ApplyQueuedMotion` + `MotionPlan` 结构) |
| R-5 | 引入 `runtime/mixer`,改为贡献者模型 + 单次 pre-Physics 写入 | `ApplyDrag` / `ApplyQueuedParameterPlan` / `ApplyLipSync` 的直接 `SetParameterValue` |
| R-6 | 修 F-1~F-4 与 §2.4 次要校验项 | 旧的包络/积分/信号源实现 |
| R-7 | 抽出 `host/` | `main.cpp` 中的窗口/托盘/D3D11/合成/WAV/麦克风代码 |
| R-8 | 接入 interaction sway / gaze 事件 | 无(纯新增能力) |
| R-9 | 依 §10 裁定结果,删除另一侧被取代的编译器 | TS 侧 `model-engine/compiler/` 或 C++ 侧对应实现 |

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
| D-1 | 权威编译器归属 | (a) C++ 为准,TS 退化为参考实现或删除;(b) TS 为准,C++ 通过 IPC 消费其产出 | 决定 R-9。`render-core/README.md:83-96` 已记录方向为原生运行时平面,但未涉及编译器 |
| D-2 | Motion Lab / Action Lab 依赖 TS 编译器的程度 | 若删除 TS 编译器,`BaseActionPreviewPanel.vue:140-388`(内联 plan 编译器)与 `usePreviewMotionPlayer` 需重写 | 这是 D-1 的主要成本项,也是 `codebase-audit.md` P1-8 已记录的问题 |
| D-3 | 是否立即启动 R-3~R-8,还是先只做组件化 | — | 当前 7 个文件已 modified 未提交;`state.yaml` 连续记录 native 侧 `evidence_gap` 未闭合 |
| D-4 | `performanceSchedule.ts` 六个 helper 的契约补齐由谁承担 | — | 阻塞 §4.3 中 stage 7 / 9 的完整 reason 集合 |
| D-5 | 频谱重音分析在原生侧的实现或显式降级 | (a) 实现 FFT 重音;(b) 声明降级并记 `evidence_gap` | 决定 F-1 修复的完整度 |

**建议**:D-1 采 (a),与 `render-core/README.md:83-96` 已记录的方向一致,且它是唯一能真正消除
`codebase-audit.md` P0-1 / P0-2 的路径。D-2 需在 D-1 裁定后单独排期。

---

## 11. 风险登记

| 风险 | 等级 | 说明 | 缓解 |
|---|---|---|---|
| 编译器移植面远大于预期 | 高 | 10 个 stage 1842 行 + `PerformanceSchedule` 2332 行 + `parameterTrackGraphCompiler` 633 行 ≈ **4800 行**业务规则,任一处常量分叉都静默改变表现 | V-1/V-2/V-3 黄金样本先行,R-3 与 R-4 之间不得插入其他改动 |
| §4.3 reason 集合不完整 | 高 | stage 7 / 9 透传 `performanceSchedule.ts` 六个未取证 helper 的 reason | D-4 前置补齐,否则负例语料无法覆盖 |
| 迁移期两套运行时并存 | 高 | Adapter 当前只允许一个 WebSocket 客户端(`render-core/README.md:91-96`),前端与原生同时直连会争抢会话 | 生产形态必须经本地 IPC 桥;R-3~R-8 期间不得让两者同时连 Adapter |
| 无法自动验证视觉质量 | 中 | 原生侧无渲染断言 | 已在 §9.4 显式声明为 `evidence_gap` |
| schema 漂移复发 | 中 | 现无 CI,`check_protocol_schema_manifest.py` 仅覆盖 TS | S-1 生成 + 纳入构建 |
| 单编译单元腐化 | 中 | `main.cpp` 3311 行 | R-7 拆分 |
| 现有 C++ 成果被误弃 | 低 | §2.1 的 6 项忠实翻译是有价值的基线 | R-4/R-5/R-6 复用而非重写 |

---

## 附:证据索引

| 结论 | 证据 |
|---|---|
| 翻译到位项 | `main.cpp:1744-2049`、`89-207`、`2051-2073`、`2079-2109`、`618-649`、`2426-2552` |
| F-1 口型失真 | `lipSyncTimelineSink.ts:189-190` ↔ `main.cpp:137` |
| F-2 blend-in 起点 | `parameterpresentation.ts:118-133` ↔ `main.cpp:2150-2162` |
| F-3 spring 算法 | `parameterpresentation.ts:230-333` ↔ `main.cpp:2111-2142` |
| F-4 速度反推 | `parameterpresentation.ts:46-78` ↔ `main.cpp:2249-2250` |
| 混音器缺失 | `parametermixer.ts:207-301` ↔ `main.cpp:1480-1524` |
| sway / gaze 缺失 | `activeparameterruntime.ts:47-69` |
| 频谱重音缺失 | `lipSyncTimelineSink.ts:191-194`、`speechsignalruntime.ts:208-213` |
| 文本 / speech cues 被丢弃 | `protocol.cpp:226-264`(已解析)↔ `main.cpp:1214-1250`、`1207-1212`(丢弃) |
| 编译器拓扑 | `stages.ts:15-29`、`compileSemanticMotion.ts:36-130`、`compileModelParameterPlan.ts:26-60`、`performanceSchedule.ts:131-1176` |
| schema 权威失效 | `schema_manifest.json`、`protocol.hpp:18-21`、`scripts/check_protocol_schema_manifest.py` |
| 双 owner(仓库既有结论) | `docs/codebase-audit.md` P0-1 / P0-2 |
| 迁移方向(仓库既有记录) | `render-core/README.md:83-96` |
