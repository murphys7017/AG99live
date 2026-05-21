# SpeechPoseStage 设计

## 1. 目标

`SpeechPoseStage` 是 ModelEngine 当前扩展路线中的第一个增强 stage。

目标是让角色在说话时拥有轻量的头部和身体姿态变化，避免动作只停留在嘴部、眼神或单一表情上。

当前设计只做 plan 级增强：

- 不做逐帧口型。
- 不做音频 RMS / phoneme / viseme。
- 不直接写 Live2D 原始参数。
- 不改变 LLM 原始 `controlledValues`。
- 只通过 `derivedValues` 补充语义轴。

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
- `context.state.warnings`

不负责：

- 不修改 `controlledValues`
- 不决定最终 `resolvedMode`
- 不解析 timing
- 不构建 parameter plan
- 不访问 runtime、WebSocket、播放器或 UI

## 4. 当前规则

当前规则保持保守，不引入复杂配置。

触发条件：

- `intent.mode === "expressive"`
- 当前 profile 中存在可用的头部或身体 derived 轴
- 当前动作不是明显空动作

目标轴选择：

- 优先选择 `control_role === "derived"` 的轴
- 只选择 `semantic_group` 属于 `head`、`body`、`torso`、`shoulder` 的轴
- 不选择 `runtime`、`ambient`、`debug` 轴
- 不选择 `mouth_open` 这类 runtime-owned 口型轴

输出原则：

- 如果用户或 LLM 已经直接控制了相同语义方向的轴，不覆盖它
- 如果 coupling 已经写入同一个 derived 轴，当前 stage 不覆盖 coupling
- 输出值围绕 neutral 做轻量偏移
- 输出后必须按 axis value range clamp

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

当前设计不新增 `CompileDiagnostics` 顶层字段，先复用现有 diagnostics：

- `appliedDerivedAxes`
- `derivedAxes`
- `compiledParameters`
- `warnings`

建议 warnings：

```text
speech_pose_skipped_no_profile
speech_pose_skipped_idle
speech_pose_skipped_no_candidate_axis
speech_pose_skipped_existing_axis:<axisId>
speech_pose_applied:<axisId>
```

## 7. 测试

新增或扩展：

```text
frontend/tests/modelEngineCompiler.test.ts
```

需要覆盖：

- expressive 动作会通过 SpeechPoseStage 生成 derived 轴
- idle 动作不会生成 speech pose 派生轴
- SpeechPoseStage 不覆盖已有 coupling 派生轴
- SpeechPoseStage 输出参数的 `source` 为 `speech_pose`
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
