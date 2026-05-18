# ModelEngine 第一轮拆分实施方案

更新时间：2026-05-18

本文是前端动作引擎第一轮结构整理的执行方案。目标不是新增动作能力，而是在**不改变当前行为**的前提下，把现有 `model-engine/` 拆成稳定的标准模块。

相关主设计文档：

- [ModelEngine 边界与分层设计](./01-ModelEngine边界与分层设计.md)

---

## 1. 本轮目标

本轮只做两件事：

1. 把 compile 主链从单体函数拆成明确的 compile pipeline
2. 把 `useModelEngine.ts` 从大而全的运行时入口，收敛成 facade + runtime scheduler 结构

本轮不做：

- 不新增 `SpeechPoseStage`
- 不新增 `ExpressionStage`
- 不新增 `ContinuityStage`
- 不新增 registry / 插件系统
- 不改协议
- 不改调参面板
- 不改 Live2D 播放器行为

本轮总原则：

```text
只改结构，不改行为。
```

也就是说：

- 当前能编译成功的动作，拆完后仍然成功
- 当前会输出的 diagnostics，拆完后仍然保留
- 当前 timing 计算结果不变
- 当前 coupling 行为不变
- 当前等待音频起播的调度行为不变

执行约束：

- 先完成 `compiler/` 拆分并验证通过，再拆 `useModelEngine.ts` 的 runtime 部分
- 每个 stage 文件都要明确写出“读取哪些 state 字段、修改哪些 state 字段”
- 第一轮不增加新的 stage 粒度，优先在 stage 文件内部拆 helper 函数

### 1.1 当前落地状态

当前 `compiler/` 第一轮主链已经落地，实际静态顺序是：

```text
IntentValidator
-> AxisResolver
-> IntensityStage
-> CouplingStage
-> ModeResolverStage
-> TimingStage
-> PlanBuilder
```

当前已经存在的文件：

```text
frontend/src/model-engine/compiler/
  compileMotionIntent.ts
  compileContext.ts
  diagnostics.ts
  pipeline.ts
  stages/
    intentValidator.ts
    axisResolver.ts
    intensityStage.ts
    couplingStage.ts
    modeResolverStage.ts
    timingStage.ts
    planBuilder.ts
```

当前 compile 主入口为：

```text
frontend/src/model-engine/compiler/compileMotionIntent.ts
```

当前已完成验证：

- `npm run typecheck:renderer`
- `npm run test:model-engine`

下一步重点不是继续扩 compiler，而是进入 `useModelEngine.ts` 的 runtime 拆分。

---

## 2. 当前代码与目标结构映射

当前 compile 主链所需的大部分逻辑已经拆入 `frontend/src/model-engine/compiler/` 目录。

### 2.1 当前函数到目标文件映射

| 当前函数 | 目标文件 |
| --- | --- |
| `compileMotionIntent` | `compiler/compileMotionIntent.ts` |
| `validateProfileForIntent` | `compiler/stages/intentValidator.ts` |
| 轴角色分类 + 轴过滤 + 错误率统计 | `compiler/stages/axisResolver.ts` |
| `normalizeSemanticAxisValue` | `compiler/stages/axisResolver.ts` |
| `applySemanticIntensity` | `compiler/stages/intensityStage.ts` |
| `applySemanticCouplings` | `compiler/stages/couplingStage.ts` |
| `isSemanticIdleDeadzone` | `compiler/stages/modeResolverStage.ts` |
| `resolveMotionTiming` | 保留在 `timing.ts`，由 `compiler/stages/timingStage.ts` 调用 |
| `buildSemanticPlanParameters` | `compiler/stages/planBuilder.ts` |
| `mapSemanticBindingValue` | `compiler/stages/planBuilder.ts` |

---

## 3. 目标目录结构

第一轮 compiler 拆分完成后，前端动作引擎目录当前结构如下：

```text
frontend/src/model-engine/
  useModelEngine.ts
  constants.ts
  contracts.ts
  normalize.ts
  planParser.ts
  settings.ts
  timing.ts

  compiler/
    compileMotionIntent.ts
    compileContext.ts
    contracts.ts
    pipeline.ts
    diagnostics.ts
    stages/
      intentValidator.ts
      axisResolver.ts
      intensityStage.ts
      couplingStage.ts
      modeResolverStage.ts
      timingStage.ts
      planBuilder.ts

  runtime/
    contracts.ts
    motionRuntimeScheduler.ts
    motionStart.ts
```

当前状态说明：

- `compiler/` 目录已经按上面的主链落地
- `runtime/` 目录已经落地 `motionRuntimeScheduler.ts` 和 `motionStart.ts`
- `contracts.ts` 已经收口为 payload boundary 类型
- `compiler/contracts.ts` 与 `runtime/contracts.ts` 已分别承接 compile 和 runtime 契约
- 当前下一步是继续评估 `useModelEngine.ts` 是否还存在可以迁出的 facade 以外实现细节

---

## 4. CompilePipeline 第一轮范围

第一轮只落下面这条主链：

```text
IntentValidator
-> AxisResolver
-> IntensityStage
-> CouplingStage
-> ModeResolverStage
-> TimingStage
-> PlanBuilder
```

说明：

- `SpeechPoseStage`、`ExpressionStage`、`ContinuityStage` 都属于第二轮之后的增强能力
- 本轮重点是把当前已经存在的主链拆成明确 stage
- 本轮先使用**静态顺序**，不引入 registry

---

## 5. `compiler/compileContext.ts`

这个文件是 compile pipeline 的公共上下文定义文件。

### 5.1 职责

- 定义 pipeline 的共享上下文
- 定义 stage 接口
- 定义 compile 过程中的可变状态
- 定义 stage 执行结果

### 5.2 需要定义的类型

#### `DynamicAxisValues`

```ts
export type DynamicAxisValues = Record<string, number>;
```

说明：

- 表示语义轴到数值的映射
- 会被 `AxisResolver`、`IntensityStage`、`CouplingStage`、`ModeResolverStage`、`PlanBuilder` 共用

#### `ResolvedAxisRoleBuckets`

```ts
export interface ResolvedAxisRoleBuckets {
  primaryAxes: string[];
  hintAxes: string[];
  derivedAxes: string[];
  runtimeAxes: string[];
}
```

说明：

- 对应当前 `compiler.ts` 中的 `roleAxisIds`
- 由 `AxisResolver` 负责填充

#### `MotionCompileMutableState`

```ts
export interface MotionCompileMutableState {
  profile: SemanticAxisProfile | null;
  axisById: Map<string, SemanticAxisDefinition>;

  roleAxisIds: ResolvedAxisRoleBuckets;

  controlledValues: DynamicAxisValues;
  derivedValues: DynamicAxisValues;
  allAxisValues: DynamicAxisValues;

  missingAxes: string[];
  forbiddenAxes: string[];
  invalidAxes: string[];

  axisErrorCount: number;
  axisErrorLimit: number;

  warnings: string[];

  resolvedMode: "idle" | "expressive";
  timing: MotionTimingResolution | null;

  parameters: SemanticParameterPlan["parameters"];
}
```

说明：

- 这是 compile 过程中的“运行时状态容器”
- 各 stage 只读写自己需要的部分
- 第一轮不追求严格不可变，先保证结构清晰

第一轮值层规则：

- `controlledValues` 是用户/LLM 直控层。
- `derivedValues` 是引擎派生层。
- `allAxisValues` 是最终编译输入层。

第一轮写入边界：

- `AxisResolver` 负责初始化 `controlledValues`
- `IntensityStage` 只允许继续修改 `controlledValues`
- `CouplingStage` 负责生成 `derivedValues` 并汇总为 `allAxisValues`
- 后续新增 `SpeechPoseStage`、`ExpressionStage`、`ContinuityStage` 时，默认只允许写 `derivedValues` 或新的派生汇总结果
- `PlanBuilder` 只读取 `allAxisValues`，不回写前面三层的语义

硬约束：

- 非“原始输入解释”类 stage 不允许回写 `controlledValues`
- 任何新增 stage 在实现前都要先标明自己修改的是哪一层值表
- `allAxisValues` 不能被当成新的原始输入来源反向覆盖前面层

维护要求：

- 每个 stage 文件顶部都要写清楚：
  - 本 stage 读取哪些字段
  - 本 stage 修改哪些字段
  - 本 stage 不负责哪些字段
- 不允许某个 stage 隐式改写自己职责之外的字段
- 如果后续需要新增字段，必须同步更新本文件中的类型定义和对应 stage 注释

#### `MotionCompileContext`

```ts
export interface MotionCompileContext {
  intent: SemanticMotionIntent;
  options: CompileOptions;
  settings: ModelEngineSettings;

  baseDiagnostics: CompileDiagnostics;
  state: MotionCompileMutableState;
}
```

说明：

- 这是每个 stage 的输入上下文
- `intent` 和 `options` 是编译原始输入
- `settings` 是归一化后的引擎设置
- `baseDiagnostics` 是初始 diagnostics
- `state` 是 stage 不断加工的中间状态

#### `MotionStageResult`

```ts
export type MotionStageResult =
  | { ok: true }
  | { ok: false; reason: string };
```

说明：

- 第一轮先使用简单结果结构
- 不需要在 stage 返回里附带复杂 payload

#### `MotionCompileStage`

```ts
export interface MotionCompileStage {
  id: string;
  run(context: MotionCompileContext): MotionStageResult;
}
```

说明：

- 第一轮先不加 `order`
- stage 顺序由 `compileMotionIntent.ts` 静态数组控制

### 5.3 需要实现的函数

#### `createInitialCompileState`

```ts
export function createInitialCompileState(): MotionCompileMutableState
```

职责：

- 初始化空 profile
- 初始化空 `axisById`
- 初始化空 role buckets
- 初始化空值表
- 初始化空 warnings
- 初始化默认 mode 为 `idle`
- 初始化 `timing = null`
- 初始化 `parameters = []`

---

## 6. `compiler/diagnostics.ts`

这个文件专门负责 compile diagnostics 的构造和收口。

### 6.1 职责

- 构造编译前的基础 diagnostics
- 从 compile context 收敛出最终 diagnostics

### 6.2 需要实现的函数

#### `buildBaseCompileDiagnostics`

```ts
export function buildBaseCompileDiagnostics(
  options: CompileOptions,
  settings: ModelEngineSettings,
): CompileDiagnostics
```

职责：

- 构造当前 `compiler.ts` 中 `baseDiagnostics` 的等价结构

需要填充：

- `usedActionLibrary`
- `compiledParameterCount`
- `timingSource`
- `resolvedMode`
- `source`
- `intensityApplied`
- `motionIntensityScale`
- `axisIntensityScale`
- `warnings`

#### `finalizeCompileDiagnostics`

```ts
export function finalizeCompileDiagnostics(
  context: MotionCompileContext,
  extra?: Partial<CompileDiagnostics>,
): CompileDiagnostics
```

职责：

- 把 context.state 里的编译结果汇总为最终 diagnostics

需要汇总：

- `warnings`
- `primaryAxes`
- `hintAxes`
- `derivedAxes`
- `runtimeAxes`
- `missingAxes`
- `forbiddenAxes`
- `invalidAxes`
- `axisErrorCount`
- `axisErrorLimit`
- `compiledParameters`
- `resolvedMode`
- `timingSource`
- `compiledParameterCount`

注意：

- 本轮不能丢掉当前 diagnostics 字段
- diagnostics 是后续 Action Lab 和调试链路的重要输入

---

## 7. `compiler/pipeline.ts`

这个文件只负责执行 stage 链。

### 7.1 职责

- 按顺序执行 stage
- 遇到失败立即停止
- 不承担业务逻辑

### 7.2 需要实现的函数

#### `runCompilePipeline`

```ts
export function runCompilePipeline(
  context: MotionCompileContext,
  stages: MotionCompileStage[],
): MotionStageResult
```

职责：

- 按顺序调用 `stage.run(context)`
- 某个 stage 返回失败时立即返回失败
- 全部通过时返回 `{ ok: true }`

---

## 8. `compiler/compileMotionIntent.ts`

这个文件是新的 compile 主入口。

### 8.1 职责

- 归一化 settings
- 初始化 compile context
- 组装 stage 链
- 执行 pipeline
- 组装最终 `SemanticParameterPlan`
- 输出 `CompileResult`

### 8.2 需要实现的函数

#### `compileMotionIntent`

```ts
export function compileMotionIntent(
  intent: SemanticMotionIntent,
  options: CompileOptions,
): CompileResult
```

处理步骤：

1. 调 `normalizeModelEngineSettings(options.settings)`
2. 调 `buildBaseCompileDiagnostics(options, normalizedSettings)`
3. 调 `createInitialCompileState()`
4. 构造 `MotionCompileContext`
5. 构造 stage 列表
6. 调 `runCompilePipeline(context, stages)`
7. 如果失败，统一走 `failCompile`
8. 如果成功，统一走 `buildSuccessResult`

#### `buildDefaultCompileStages`

```ts
function buildDefaultCompileStages(): MotionCompileStage[]
```

返回顺序固定的 stage 列表：

```ts
[
  intentValidatorStage,
  axisResolverStage,
  intensityStage,
  couplingStage,
  modeResolverStage,
  timingStage,
  planBuilderStage,
]
```

#### `failCompile`

```ts
function failCompile(
  reason: string,
  context: MotionCompileContext,
): CompileResult
```

职责：

- 统一失败返回结构
- 保证 diagnostics 仍然完整

#### `buildSuccessResult`

```ts
function buildSuccessResult(
  context: MotionCompileContext,
): CompileResult
```

职责：

- 用 `context.state.parameters`
- `context.state.resolvedMode`
- `context.state.timing`
- `context.intent`
- `context.state.profile`

组装最终 `SemanticParameterPlan`

---

## 9. `compiler/stages/intentValidator.ts`

### 9.1 职责

- 校验 `intent` 和当前 profile 引用一致
- 校验编译前提是否满足
- 把 profile 和 `axisById` 写入 context

### 9.2 需要导出的成员

#### `intentValidatorStage`

```ts
export const intentValidatorStage: MotionCompileStage
```

#### `runIntentValidator`

```ts
export function runIntentValidator(
  context: MotionCompileContext,
): MotionStageResult
```

#### `validateProfileForIntent`

```ts
function validateProfileForIntent(
  intent: SemanticMotionIntent,
  profile: SemanticAxisProfile | null | undefined,
): string
```

### 9.3 需要保留的校验逻辑

必须保留当前这些失败条件：

- `semantic_profile_missing`
- `semantic_profile_id_mismatch:*`
- `semantic_profile_model_mismatch:*`
- `semantic_profile_revision_mismatch:*:*`
- `emotion_label_empty`
- `semantic_intent_axes_empty`

### 9.4 成功后必须写入的状态

- `context.state.profile`
- `context.state.axisById`

---

## 10. `compiler/stages/axisResolver.ts`

这是第一轮最关键的 stage 之一。

### 10.1 职责

- 根据 `SemanticAxisProfile` 分类各类 axis
- 只允许 LLM 控制 `primary` 和 `hint`
- 过滤 unknown axis / forbidden role axis
- 校验值是否是有限数字
- 对值做 range clamp
- 收集 invalid / forbidden / missing / warnings
- 计算 axis error count / limit
- 构建 `controlledValues`

### 10.2 需要导出的成员

#### `axisResolverStage`

```ts
export const axisResolverStage: MotionCompileStage
```

#### `runAxisResolver`

```ts
export function runAxisResolver(
  context: MotionCompileContext,
): MotionStageResult
```

### 10.3 需要实现的内部函数

#### `buildRoleAxisBuckets`

```ts
function buildRoleAxisBuckets(
  profile: SemanticAxisProfile,
): ResolvedAxisRoleBuckets
```

#### `computeAxisErrorLimit`

```ts
function computeAxisErrorLimit(
  buckets: ResolvedAxisRoleBuckets,
): number
```

#### `collectMissingPrimaryAxes`

```ts
function collectMissingPrimaryAxes(
  profile: SemanticAxisProfile,
  controlledValues: DynamicAxisValues,
  warnings: string[],
): string[]
```

#### `normalizeSemanticAxisValue`

```ts
function normalizeSemanticAxisValue(
  axis: SemanticAxisDefinition,
  value: number,
): { value: number; warning: string }
```

这个函数直接从当前 `compiler.ts` 搬迁，行为不变。

### 10.4 必须保留的语义

本 stage 结束后，必须正确得到：

- `roleAxisIds`
- `controlledValues`
- `missingAxes`
- `forbiddenAxes`
- `invalidAxes`
- `axisErrorCount`
- `axisErrorLimit`
- `warnings`

并且必须保留当前“错误率超限直接失败”的逻辑。

实现约束：

- `AxisResolverStage` 保持为一个 stage，不继续拆成多个 stage
- 如果内部逻辑过长，只在本文件内拆 helper 函数
- 推荐至少拆出下面这些 helper：
  - `buildRoleAxisBuckets`
  - `normalizeSemanticAxisValue`
  - `computeAxisErrorLimit`
  - `collectMissingPrimaryAxes`
  - 一个负责遍历 `intent.axes` 并填充 `controlledValues / warnings / invalid / forbidden` 的内部函数

原因：

- 这些逻辑都属于“LLM 可控轴裁决”同一层职责
- 第一轮如果继续拆 stage，会增加调试和回归验证成本

---

## 11. `compiler/stages/intensityStage.ts`

### 11.1 职责

- 对 `controlledValues` 应用全局强度和单轴强度
- 对越界值做 clamp
- 输出 warning

### 11.2 需要导出的成员

#### `intensityStage`

```ts
export const intensityStage: MotionCompileStage
```

#### `runIntensityStage`

```ts
export function runIntensityStage(
  context: MotionCompileContext,
): MotionStageResult
```

#### `applySemanticIntensity`

```ts
function applySemanticIntensity(
  value: number,
  axis: SemanticAxisDefinition,
  mode: SemanticMotionIntent["mode"],
  motionIntensityScale: number,
  axisIntensityScale: number,
): { value: number; warning: string }
```

### 11.3 注意

本 stage 只做数值强度缩放，不做：

- mode 解析
- timing 解析
- coupling

---

## 12. `compiler/stages/couplingStage.ts`

### 12.1 职责

- 根据 profile 的 `couplings` 做语义轴联动
- 基于 `controlledValues` 补出 `derivedValues`
- 生成 `allAxisValues`

### 12.2 需要导出的成员

#### `couplingStage`

```ts
export const couplingStage: MotionCompileStage
```

#### `runCouplingStage`

```ts
export function runCouplingStage(
  context: MotionCompileContext,
): MotionStageResult
```

#### `applySemanticCouplings`

```ts
function applySemanticCouplings(
  sourceValues: DynamicAxisValues,
  profile: SemanticAxisProfile,
  axisById: Map<string, SemanticAxisDefinition>,
): { values: DynamicAxisValues; warnings: string[] }
```

#### `dynamicAxisValuesEqual`

```ts
function dynamicAxisValuesEqual(
  left: DynamicAxisValues,
  right: DynamicAxisValues,
): boolean
```

### 12.3 注意

本 stage 完成后：

- `context.state.derivedValues` 必须可用
- `context.state.allAxisValues` 必须是最终用于 mode/timing/plan build 的值表

---

## 13. `compiler/stages/modeResolverStage.ts`

这是第一轮建议新增的 stage。

### 13.1 职责

- 根据 `allAxisValues` 判断当前动作是否落入 idle deadzone
- 决定最终 mode 是 `idle` 还是 `expressive`

### 13.2 需要导出的成员

#### `modeResolverStage`

```ts
export const modeResolverStage: MotionCompileStage
```

#### `runModeResolverStage`

```ts
export function runModeResolverStage(
  context: MotionCompileContext,
): MotionStageResult
```

#### `isSemanticIdleDeadzone`

```ts
function isSemanticIdleDeadzone(
  axisValues: DynamicAxisValues,
  axisById: Map<string, SemanticAxisDefinition>,
): boolean
```

### 13.3 行为要求

- 如果 `intent.mode === "idle"`，最终 mode 为 `idle`
- 如果 `intent.mode === "expressive"` 但所有轴都落在 soft range 内，则最终 mode 为 `idle`
- 否则为 `expressive`

本 stage 必须负责：

- `context.state.resolvedMode`

---

## 14. `compiler/stages/timingStage.ts`

### 14.1 职责

- 根据 `resolvedMode`
- `intent.duration_hint_ms`
- `options.targetDurationMs`

计算最终 timing

### 14.2 需要导出的成员

#### `timingStage`

```ts
export const timingStage: MotionCompileStage
```

#### `runTimingStage`

```ts
export function runTimingStage(
  context: MotionCompileContext,
): MotionStageResult
```

### 14.3 依赖

内部直接调用现有：

- `resolveMotionTiming` from `timing.ts`

### 14.4 结果

- `context.state.timing`

---

## 15. `compiler/stages/planBuilder.ts`

### 15.1 职责

- 把 `allAxisValues` 映射到 parameter bindings
- 生成最终 `SemanticParameterPlan.parameters`

### 15.2 需要导出的成员

#### `planBuilderStage`

```ts
export const planBuilderStage: MotionCompileStage
```

#### `runPlanBuilderStage`

```ts
export function runPlanBuilderStage(
  context: MotionCompileContext,
): MotionStageResult
```

#### `buildSemanticPlanParameters`

```ts
function buildSemanticPlanParameters(
  axisValues: DynamicAxisValues,
  profile: SemanticAxisProfile,
  axisById: Map<string, SemanticAxisDefinition>,
  controlledAxisIds: Set<string>,
):
  | { ok: true; parameters: SemanticParameterPlan["parameters"] }
  | { ok: false; reason: string }
```

#### `mapSemanticBindingValue`

```ts
function mapSemanticBindingValue(
  axis: SemanticAxisDefinition,
  binding: SemanticAxisParameterBinding,
  value: number,
):
  | { ok: true; targetValue: number }
  | { ok: false; reason: string }
```

### 15.3 必须保留的失败条件

- `unknown_axis:*`
- `axis_has_no_parameter_binding:*`
- `duplicate_parameter_binding:*`
- `binding_input_range_zero:*:*`
- `binding_weight_invalid:*:*`
- `binding_target_not_finite:*:*`
- `semantic_plan_parameters_empty`

### 15.4 本 stage 结束后

- `context.state.parameters` 必须已填充

---

## 16. Compile 主入口

当前 compile 主入口直接使用：

```text
frontend/src/model-engine/compiler/compileMotionIntent.ts
```

不保留额外转发入口。

---

## 17. `useModelEngine.ts` 第一轮拆分方向

`useModelEngine.ts` 当前同时承担：

- 入站 payload 排队
- 等待音频起播
- turn 过期清理
- compile 触发
- 直接调用 `playPlan`
- 状态 message 更新
- history 记录

第一轮建议拆成：

- facade：`useModelEngine.ts`
- runtime scheduler：`runtime/motionRuntimeScheduler.ts`
- payload 启动器：`runtime/motionStart.ts`

执行顺序要求：

- 本节相关改动必须放在 `compiler/` 主链拆分完成并验证通过之后
- 不允许 compiler 主链和 runtime scheduler 同时大改
- 如果 `compiler/` 切换后仍有 diagnostics 或播放时机问题，优先修完再进入 runtime 拆分

---

## 18. `runtime/motionRuntimeScheduler.ts`

### 18.1 职责

- 管理 pending motion payload 队列
- 等待音频起播或超时
- 根据 turn 变化清理过期 payload
- 在合适时机触发真正的 payload start

### 18.2 建议迁出的函数

从 `useModelEngine.ts` 中迁出：

- `resolveSessionKey`
- `findStartedSegment`
- `resolveMotionTargetDurationMs`
- `resolveMotionTargetDurationMsForContext`
- `tryStartPendingPayload`
- `queueInboundPayload`
- `notifyAudioPlaybackStarted`
- `notifyCurrentTurnChanged`
- `clearPendingPayload`
- `clearAllPendingPayloads`
- `syncPendingState`

### 18.3 推荐入口函数

#### `createMotionRuntimeScheduler`

```ts
export function createMotionRuntimeScheduler(
  dependencies: ModelEngineDependencies,
  hooks: {
    onPendingStateChanged: (pendingCount: number, pendingMessageId: string) => void;
    onStartPayload: (
      payload: NormalizedMotionPayload,
      context: StartPayloadContext,
    ) => boolean;
    onStatusMessage?: (message: string) => void;
  },
)
```

返回对象建议包含：

- `queueInboundPayload`
- `notifyAudioPlaybackStarted`
- `notifyCurrentTurnChanged`
- `clearAllPendingPayloads`

---

## 19. `runtime/motionStart.ts`

### 19.1 职责

- 启动已经归一化的 motion payload
- 对 semantic intent 走 compile 再 play
- 对 direct plan 直接 play

### 19.2 建议迁出的函数

从 `useModelEngine.ts` 中迁出：

- `startPayload`
- `reportInvalidPayload`

### 19.3 推荐函数结构

#### `startNormalizedMotionPayload`

```ts
export function startNormalizedMotionPayload(
  payload: NormalizedMotionPayload,
  context: StartPayloadContext,
  dependencies: ModelEngineDependencies,
  engineState: ModelEngineRuntimeStateController,
): boolean
```

内部再拆成：

#### `startSemanticIntentPayload`

```ts
function startSemanticIntentPayload(...)
```

职责：

- 调 `compileMotionIntent`
- 失败则写 failed 状态
- 成功则调用 `playPlan`

#### `startDirectPlanPayload`

```ts
function startDirectPlanPayload(...)
```

职责：

- 直接调用 `playPlan`
- 记录 started plan
- 上报 `onPlanStarted`

---

## 20. `useModelEngine.ts` 第一轮最终职责

拆分后，`useModelEngine.ts` 应只保留下面这些职责：

### 20.1 状态持有

- `state`
- `setState`

### 20.2 facade API

- `ingestInboundPayload`
- `ingestNormalizedPayload`
- `notifyAudioPlaybackStarted`
- `notifyCurrentTurnChanged`
- `playPreviewPayload`
- `stop`

### 20.3 轻量装配

- 创建 scheduler
- 把 scheduler 和 payload start 连接起来
- 提供状态回调

### 20.4 不再保留的重逻辑

以下逻辑不应该继续直接写在 `useModelEngine.ts` 内部：

- pending queue 细节
- 音频等待超时细节
- started segment 查找细节
- compile 入口细节
- direct plan 启动细节

---

## 21. 第一轮明确不做的文件

本轮不创建下面这些文件：

```text
compiler/stages/speechPoseStage.ts
compiler/stages/expressionStage.ts
compiler/stages/continuityStage.ts
compiler/registry.ts
compiler/extensions.ts
```

理由：

- 主链还没拆稳
- 现在上 registry 会增加理解成本
- 当前目标是把现有能力收口成标准结构，不是马上上插件系统

---

## 22. 第一轮实施顺序

当前执行顺序仍按下面的边界推进，但 compiler 部分已经完成。

### Step 1（已完成）

创建基础文件：

- `compiler/compileContext.ts`
- `compiler/diagnostics.ts`
- `compiler/pipeline.ts`

此时不改业务逻辑，只先建立公共结构。

### Step 2（已完成）

创建：

- `compiler/stages/intentValidator.ts`

把 `validateProfileForIntent` 迁入。

### Step 3（已完成）

创建：

- `compiler/stages/axisResolver.ts`

把下面逻辑迁入：

- role buckets
- 轴角色过滤
- unknown / forbidden / invalid 收集
- error rate 统计
- `normalizeSemanticAxisValue`
- missing primary 收集

### Step 4（已完成）

创建：

- `compiler/stages/intensityStage.ts`

迁入：

- `applySemanticIntensity`

### Step 5（已完成）

创建：

- `compiler/stages/couplingStage.ts`

迁入：

- `applySemanticCouplings`
- `dynamicAxisValuesEqual`

### Step 6（已完成）

创建：

- `compiler/stages/modeResolverStage.ts`

迁入：

- `isSemanticIdleDeadzone`

### Step 7（已完成）

创建：

- `compiler/stages/timingStage.ts`

接入现有：

- `resolveMotionTiming`

### Step 8（已完成）

创建：

- `compiler/stages/planBuilder.ts`

迁入：

- `buildSemanticPlanParameters`
- `mapSemanticBindingValue`

### Step 9（已完成）

创建：

- `compiler/compileMotionIntent.ts`

完成 compile 主入口装配。

### Step 10（已完成）

开始拆 `useModelEngine.ts`：

- 先迁 runtime scheduler
- 再迁 payload start

当前检查点：

- `IntentValidator + AxisResolver` 主骨架已完成
- compile 主链各 stage 已完整落位
- compile 主入口为 `frontend/src/model-engine/compiler/compileMotionIntent.ts`
- compiler 相关验证已通过
- runtime scheduler 已迁入 `runtime/motionRuntimeScheduler.ts`
- payload start 已迁入 `runtime/motionStart.ts`

当前已完成验证：

- `npm run typecheck:renderer`
- `npm run test:model-engine`
- `npm run test:turn-orchestrator`
- `npm run test:coordinator`

### Step 11（当前下一步）

继续收口 facade 与 runtime 的剩余边界：

- 评估 `useModelEngine.ts` 是否还保留了不该继续停留在 facade 的实现细节
- 评估 runtime state 控制是否需要继续下沉为更窄的状态控制模块
- 为后续 `ExtensionRegistry` 和增强 stage 预留更清晰的 runtime/compile 连接点

---

## 23. 第一轮验收标准

拆分完成后，需要满足下面这些条件：

### 23.1 Compile 行为

- `compileMotionIntent()` 对外接口不变
- 输入输出结构不变
- `CompileResult.reason` 不变
- `CompileDiagnostics` 主要字段不丢失

### 23.2 Runtime 行为

- 动作仍然等待音频起播
- preview 仍然可用
- turn 切换后仍然清掉过期 pending payload

### 23.3 代码结构

- compile 主入口不再承担全部 compile 逻辑
- stage 文件职责单一
- `useModelEngine.ts` 明显变薄

### 23.4 验证要求

至少需要补或通过的验证包括：

- 现有 `model-engine` compile 相关单测
- timing 相关单测
- preview playback 相关路径验证
- turn playback 触发动作用例验证

推荐验证节奏：

1. 完成 `IntentValidator + AxisResolver` 后，先跑一轮 compile 相关单测
2. 完成 `Intensity + Coupling + ModeResolver + Timing + PlanBuilder` 后，再跑一轮 compile 相关单测
3. compile 主入口切换完成后，跑一轮更完整的 `model-engine` / `turn-playback` 相关测试
4. 进入 `useModelEngine.ts` runtime 拆分前，再做一次当前行为基线验证
5. runtime 拆分完成后，再跑一轮包含 preview / playback / turn orchestration 的验证

验证原则：

- 优先跑与当前改动直接相关的测试
- 每次切换对外入口或调度行为时，都要增加一轮更完整的验证
- 如果测试 import 路径或 mock 结构因拆分发生变化，应先调整测试，再继续后续步骤

---

## 24. 第二轮再做什么

第一轮完成后，再做下面这些扩展能力：

### 24.1 `SpeechPoseStage`

输入建议：

- `resolvedMode`
- `timing`
- `messageId / turnId / playbackTurnId`

输出建议：

- 头部 / 身体轻量姿态相关 semantic axes

### 24.2 `ExpressionStage`

输入建议：

- `emotion_label`
- 当前 semantic axes
- few-shot 有效示例
- model-native expression example library

输出建议：

- 表情相关 semantic axis 补充或 hint

### 24.3 `ContinuityStage`

输入建议：

- 上一段 plan
- 当前 plan
- 当前播放状态

输出建议：

- 软衔接后的 plan

---

## 25. 本轮建议的起手文件

如果本轮现在立刻开始实现，建议从下面四个文件起手：

```text
compiler/compileContext.ts
compiler/diagnostics.ts
compiler/pipeline.ts
compiler/stages/intentValidator.ts
```

然后马上接：

```text
compiler/stages/axisResolver.ts
```

原因：

- 这两步完成后，compile pipeline 的骨架就建立起来了
- 后面继续拆 intensity / coupling / timing / planBuilder 时会顺很多
