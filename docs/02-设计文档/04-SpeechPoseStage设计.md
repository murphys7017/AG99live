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
  - 使用 WAV RMS 的平滑包络调节头身随动强度，让停顿收敛、发声时增强
  - 不做 phoneme / viseme；嘴型仍由独立 lip sync 参数驱动

当前职责定位：

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
- `context.intent.intent_tags`
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

当前不以 `emotion_label` 作为进入点；如果上游只有标签串，应该先在接收层里归一化成 `intent_tags`。

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

## 10. 说话随动调参位置

说话随动分为“模型能力幅度”和“音频实时增益”两层，调整时不要混为一处。

### 10.1 基础振幅、权重与频率

文件：

```text
astrbot_plugin_ag99live_adapter/live2d/scanner/scan.py
```

常量：

```text
VOICE_FOLLOWING_TUNING
```

这是说话随动风格的唯一基础配置区。`VOICE_FOLLOWING_CHANNEL_SPECS` 由
`_build_voice_following_channel_specs()` 自动生成，不应直接维护生成结果。

配置按动作组组织：

```python
VOICE_FOLLOWING_TUNING = {
    "roll": {
        "frequency_hz": 1.65,
        "phase": 0.35,
        "head": {"amplitude": 8.5, "weight": 1.0},
        "body": {"amplitude": 6.0, "weight": 0.85},
    },
    "yaw": {
        "frequency_hz": 1.55,
        "phase": 0.0,
        "head": {"amplitude": 6.5, "weight": 1.0},
        "body": {"amplitude": 4.5, "weight": 0.85},
    },
    "pitch": {
        "frequency_hz": {"head": 0.68, "body": 0.55},
        "phase": {"head": 0.35, "body": 0.55},
        "head": {"amplitude": 1.2, "weight": 0.35},
        "body": {"amplitude": 0.8, "weight": 0.25},
    },
}
```

日常调节角色说话风格时只修改这一块。横向组共用单个
`frequency_hz/phase`，因此代码结构本身会保证头身同向同步；俯仰组允许头身使用不同节奏，以维持克制的上下跟随。

字段含义：

| 字段 | 作用 |
| --- | --- |
| `amplitude` | 参数围绕 neutral 摆动的基础最大幅度 |
| `weight` | 对基础幅度的静态缩放 |
| `frequency_hz` | 每秒振荡频率 |
| `phase` | 动作组之间的相位差；同一方向的头身通道必须保持一致 |

当前为方便早期观察，横向扭转和摇晃采用偏明显的测试配置：

| 通道 | amplitude | weight | frequency_hz |
| --- | ---: | ---: | ---: |
| `head_yaw` | 6.5 | 1.0 | 1.55 |
| `body_yaw` | 4.5 | 0.85 | 1.55 |
| `head_roll` | 8.5 | 1.0 | 1.65 |
| `body_roll` | 6.0 | 0.85 | 1.65 |

`head_pitch` 和 `body_pitch` 暂时保持小幅度，避免角色说话时频繁上下点头。完成实际模型测试后，优先回调 `frequency_hz`，其次调整 `amplitude`；不要先降低音频响应，否则会重新出现“数值在动但肉眼不可见”。

横向动作必须遵守以下身体逻辑：

- `head_yaw` 与 `body_yaw` 使用相同的 phase 和 frequency，保证头向哪边扭，身体就向同一边跟随。
- `head_roll` 与 `body_roll` 使用相同的 phase 和 frequency，保证头向哪边歪，身体就向同一边侧倾。
- 同组头部有效幅度必须大于身体有效幅度，即 `head amplitude × weight > body amplitude × weight`。
- yaw 和 roll 可以使用不同 phase，避免扭转与侧倾始终在同一时刻到达峰值，但不能破坏各自组内的头身同步。
- 当前配置有意突出侧倾摇晃、收小左右扭头。后续调参必须成组修改，不能只修改头部或身体单侧通道。

修改扫描侧配置后，需要重新生成或同步模型信息，新的 `voice_following_profile` 才会下发到前端。

### 10.2 音频能量响应

文件：

```text
frontend/src/live2d/WebSDK/src/lappmodel.ts
```

相关常量：

```text
SPEECH_AUDIO_RMS_GAIN
SPEECH_AUDIO_GAIN_FLOOR
SPEECH_AUDIO_GAIN_SPAN
SPEECH_AUDIO_GAIN_MAX
SPEECH_AUDIO_PITCH_GAIN_MAX
SPEECH_AUDIO_ENVELOPE_ATTACK_PER_SECOND
SPEECH_AUDIO_ENVELOPE_RELEASE_PER_SECOND
```

这一层决定发声强弱如何缩放 profile 的基础幅度：

- `RMS_GAIN` 决定普通 TTS 音量多快进入可见随动区间。
- `GAIN_FLOOR` 决定弱音和短暂停顿时保留多少基础运动。
- `GAIN_SPAN / GAIN_MAX` 决定正常和强音时最多放大多少。
- `ATTACK / RELEASE` 决定随动起势和收势速度。

嘴型仍使用独立的 `lipSyncValue`，调整上述头身随动常量不会直接放大张嘴幅度。
