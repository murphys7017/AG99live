# SpeechPoseStage 设计

## 1. 目标

`SpeechPoseStage` 是 ModelEngine 当前扩展路线中的第一个增强 stage。

目标是在音频开始播放且模型提供 `VoiceFollowingProfile` 时，让角色说话时拥有轻量的头部和身体姿态变化，避免 TTS 播放期间只停留在嘴部、眼神或单一表情上。

当前 Mk6 主轴口径下，头部偏转、身体扭转/摇晃、眼睛开闭和视线都属于动作骨架，并由 LLM 可见的 primary/hint 轴表达。`SpeechPoseStage` 不负责重新选择这些主轴；说话随动优先使用模型扫描生成的 `VoiceFollowingProfile`，旧的 dedicated derived 轴只作为兼容 fallback。

当前设计分两层：

- `SpeechPoseStage` 只做 plan 级增强：
  - 不做逐帧口型。
  - 不做音频 RMS / phoneme / viseme。
  - 不直接写 Live2D 原始参数。
  - 不改变 LLM 原始 `controlledValues`。
  - 优先通过 `VoiceFollowingProfile` 生成 `source=speech_pose` 的 plan parameters；没有该 profile 时才通过 `derivedValues` 补充语义轴。
- SDK 执行层负责 `speech_pose` 的逐帧调制：
  - `voice_following_profile` 的 `phase / neutral / amplitude / weight` 会进入前端执行层
  - 说话期间头身参数围绕 neutral 做连续振荡，而不是整段只缓到一个静态 target
  - 仍然不引入 RMS / phoneme / viseme

当前待办定位：

- `SpeechPoseStage` 负责“说话时随动”的 plan 级补偿。
- 说话随动属于 speaking idle：它由运行时音频 started 事实触发，不要求 `intent.mode === "expressive"`，也不把 `resolvedMode` 强行提升为 `expressive`。
- 连续多段之间的 soft handoff、不硬切、残留和惯性由 SDK 侧 `ParameterPresentationLayer` 统一承接。

## 2. 放置位置

目标文件：

```text
frontend/src/model-engine/compiler/stages/speechPoseStage.ts
```

接入位置：

```text
AxisResolver
-> IntensityStage
-> CouplingStage
-> SpeechPoseStage
-> ModeResolverStage
-> TimingStage
-> PlanBuilder
```

注册位置：

```text
frontend/src/model-engine/compiler/registry.ts
```

`SpeechPoseStage` 注册为：

```text
kind: "extension"
order: 45
id: "speechPose"
```

## 3. Stage 职责

读取：

- `context.intent.mode`
- `context.intent.emotion_label`
- `context.options.speechActive`
- `context.options.model.voice_following_profile`
- `context.state.profile`
- `context.state.axisById`
- `context.state.controlledValues`
- `context.state.derivedValues`
- `context.state.allAxisValues`
- `context.options.targetDurationMs`

写入：

- `context.state.derivedValues`
- `context.state.axisValueSources`
- `context.state.appliedDerivedAxes`
- `context.state.allAxisValues`
- `context.state.parameters`
- `context.state.warnings`

不负责：

- 不修改 `controlledValues`
- 不决定最终 `resolvedMode`
- 不解析 timing
- 不访问 runtime、WebSocket、播放器或 UI

## 4. 当前规则

当前规则保持保守，不引入复杂配置。

触发条件：

- `context.options.speechActive === true`，即当前消息或 turn 的音频已经 started
- 当前模型存在可用的 `VoiceFollowingProfile` channel；或旧 profile 中存在可用的、专门用于说话姿态补偿的头部或身体 derived 轴
- 允许 `intent.mode === "idle"`，说话随动属于 speaking idle
- 允许空 `axes` 的 speaking idle 意图进入 compile pipeline，由 `SpeechPoseStage` 补出 plan 级 speech pose 参数

`VoiceFollowingProfile` channel 选择：

- 由模型扫描侧根据标准 Live2D 头部/身体 channel 生成，例如 `head_yaw/head_pitch/head_roll/body_yaw/body_pitch/body_roll`
- 每个 channel 直接绑定一个 Live2D parameter、neutral、output_range、amplitude、weight 和 phase
- 如果目标 parameter 已经由语义轴或前置 plan 参数占用，当前 stage 跳过该 channel

legacy derived 轴 fallback：

- 只选择 `control_role === "derived"` 的轴
- 只选择 `semantic_group` 属于 `head`、`body`、`torso`、`shoulder` 的轴
- 只选择明确标注为 speech/talk/speaking/voice 或中文说话语义的 dedicated 轴，避免把普通 coupling derived 轴误当说话姿态轴
- 不选择 `primary`、`hint`、`runtime`、`ambient`、`debug` 轴
- 不选择 `mouth_open` 这类 runtime-owned 口型轴
- 不把表情辅轴当作说话姿态补偿目标，例如 `mouth_smile`、`brow_bias`、`gaze_x`、`gaze_y`

输出原则：

- `VoiceFollowingProfile` 输出直接追加为 `source=speech_pose` 的 plan parameters
- legacy derived fallback 输出到 `derivedValues`
- 如果用户或 LLM 已经直接控制了同一个参数或相同语义方向的轴，不覆盖它
- 如果 coupling 已经写入同一个 derived 轴，当前 stage 不覆盖 coupling
- 输出 plan 会在参数条目的独立 modulation 字段里保留 `neutral / amplitude / phase` 元信息，供 SDK 执行层做逐帧调制
- 输出后必须按 axis value range clamp

## 4.1 与主轴/辅轴设计的关系

当前整体设计把动作轴分成：

| 类型 | 说明 |
| --- | --- |
| 动作主轴 | 头部偏转、身体扭转/摇晃、眼睛开闭等动作骨架 |
| 表情辅轴 | 嘴角笑意、眉毛、视线偏移等表情态度微调 |
| 运行时轴 | 嘴巴开闭、呼吸等由音频或运行时驱动的轴 |

`SpeechPoseStage` 只处理说话场景下缺失的轻量姿态补偿。身体动作已经是主轴体系的一部分，因此说话随动不进入 `SemanticAxisProfile` 的 LLM 可见主轴设计。`VoiceFollowingProfile` 是模型能力 profile；如果后续 profile 额外定义说话姿态派生轴，`SpeechPoseStage` 也不能覆盖 LLM 或用户已经直接表达的主轴/辅轴动作。

`idle` 在这里表示基础状态或轻量持续表现，不等于完全静止。说话随动作为 speaking idle 层存在；明确动作表演仍由 `expressive` 和 LLM 控制的主轴/辅轴表达。

## 5. 建议内部函数

```ts
export const speechPoseStage: MotionCompileStage;
```

```ts
export function runSpeechPoseStage(
  context: MotionCompileContext,
): MotionStageResult;
```

```ts
function selectSpeechPoseAxes(
  context: MotionCompileContext,
): SemanticAxisDefinition[];
```

```ts
function buildSpeechPoseValues(
  axes: SemanticAxisDefinition[],
  context: MotionCompileContext,
): DynamicAxisValues;
```

```ts
function resolveSpeechPoseOffset(
  axis: SemanticAxisDefinition,
  context: MotionCompileContext,
): number;
```

## 6. Diagnostics

当前 diagnostics 需要暴露运行时触发事实和 stage 结果：

- `speechActive`
- `appliedDerivedAxes`
- `derivedAxes`
- `compiledParameters`
- `warnings`

建议 warnings：

```text
speech_pose_skipped_no_profile
speech_pose_skipped_no_candidate_axis
speech_pose_skipped_existing_axis:<axisId>
speech_pose_skipped_existing_parameter:<parameterId>
speech_pose_applied:<axisId>
speech_pose_applied:<parameterId>
```

## 7. 测试

新增或扩展：

```text
frontend/tests/modelEngineCompiler.test.ts
```

需要覆盖：

- 模型提供 `VoiceFollowingProfile` 且音频 started 时，idle 动作会通过 SpeechPoseStage 生成 `speech_pose` 参数
- legacy profile 提供 dedicated derived 轴且音频 started 时，idle 动作也会通过 SpeechPoseStage 生成 derived 轴
- 非 speechActive 场景不会生成 speech pose 派生轴
- 默认 Mk6 profile 未提供 dedicated derived 轴时，SpeechPoseStage 会跳过
- SpeechPoseStage 不覆盖已有 coupling 派生轴
- SpeechPoseStage 输出参数的 `source` 为 `speech_pose`
- speaking idle 的 audio_sync timing 不被普通 idle 的 2200ms 上限截断
- diagnostics 的 `appliedDerivedAxes` 包含实际写入的 speech pose 轴
- registry 中 `speechPose` 位于 `coupling` 之后、`modeResolver` 之前

验证命令：

```text
npm run typecheck:renderer
npm run test:model-engine
```

## 8. 维护标准

- 当前已有 compile 行为不回退
- `SpeechPoseStage` 只通过 registry 接入
- stage 文件顶部写清 Reads / Writes / Does not own
- 不新增协议字段
- 不新增 runtime 依赖
- 不新增 UI 控件
- 不改变 `compileMotionIntent()` 对外接口
- `speechActive` 是前端 compiler option，不是 `engine.motion_intent.v2` 协议字段

## 9. 与连续表现层的关系

`SpeechPoseStage` 和后续 `ParameterPresentationLayer` 的边界必须保持清楚：

- `SpeechPoseStage`：
  - 负责当前段说话姿态“应该往哪里偏一点”
  - 只产出 plan 级 derived 轴
  - 不维护逐帧状态

- `ParameterPresentationLayer`：
  - 负责这些姿态“怎样连续地表现出来”
  - 维护逐帧状态、惯性、衰减、残留和层间混合
  - 处理连续多段之间的 handoff

因此当前顺序是：

1. 先做 `SpeechPoseStage`
2. 再做 `ParameterPresentationLayer`
3. 连续表现统一由 `ParameterPresentationLayer` 承接
