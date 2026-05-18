# ModelEngine 驱动系统边界与分层设计

> 状态：当前主设计文档。本文是前端动作引擎结构方案的维护入口。

更新时间：2026-05-18

## 1. 当前结论

前端 ModelEngine 的目标形态是“可挂载能力模块”的动作引擎。

当前主链路：

```text
engine.motion_intent.v2 / engine.parameter_plan.v2
-> normalizeMotionPayload / parseSemanticParameterPlan
-> useModelEngine facade
-> motionRuntimeScheduler
-> motionStart
-> compileMotionIntent
-> motionPlayer.playPlan
-> Live2D runtime
```

当前有效主路径：

- `engine.motion_intent.v2 -> engine.parameter_plan.v2`
- `SemanticAxisProfile -> semantic axes -> parameter bindings -> parameter plan`
- `profile.couplings -> derived semantic axes`
- `motionPlayer.playPlan -> Live2D parameter write`

当前结构判断：

- `useModelEngine.ts` 已经收口为 facade，当前主要负责状态持有、runtime 装配和对外 API。
- `motionRuntimeScheduler.ts` 已承担 pending queue、音频起播等待、turn 过期清理和启动时机决策。
- `motionStart.ts` 已承担 payload 启动、semantic compile 触发、direct plan 启动和失败状态写回。
- `compileMotionIntent.ts` 是当前 compile 主入口，真正的编译逻辑已经进入 `compiler/` 目录下的静态 pipeline stages。
- `settings.ts` 的设置模型需要面向 `SemanticAxisProfile`。
- `CompileDiagnostics` 需要按 stage 聚合。
- 新增表情判断、说话姿态、动作优化、连贯优化时，应通过 stage / registry 挂载。

当前已经落地的 compile 主链：

```text
IntentValidator
-> AxisResolver
-> IntensityStage
-> CouplingStage
-> ModeResolverStage
-> TimingStage
-> PlanBuilder
```

下一阶段主目标：

```text
设计并整理前端 ModelEngine 结构
-> 第一轮 compiler / runtime 拆分已经完成
-> 建立 stage / registry 扩展入口
-> 按 SpeechPoseStage、ExpressionStage、ContinuityStage 的顺序补动作增强能力
```

## 2. 协议与代码清理原则

当前涉及的动作 schema：

| Payload | Schema |
| --- | --- |
| Adapter 外部动作载荷 | `engine.motion_intent.v2` |
| 前端内部执行计划 | `engine.parameter_plan.v2` |

边界规则：

- 未列入当前 schema 的 payload 直接拒绝。
- 不添加隐式 payload 修复逻辑。
- 不添加多版本或旧协议回退路径。
- 不添加服务于废弃入口的防御性代码。
- 边界 parser 可以接收 `unknown`，内部类型必须收窄为当前协议类型。

需要保留的运行时保护：

- `schema_version` 严格校验。
- 动作 payload 等待音频起播的短等待窗口。
- preview 入口的 runtime parse。
- turn/message/playbackTurn 上下文过期清理。

清理判断标准：

```text
服务当前 v2 主路径稳定性的保护保留。
服务废弃入口静默运行的回退分支清理。
```

## 3. 目标边界

ModelEngine 负责：

- 接收已经归一化的动作 payload。
- 校验 `engine.motion_intent.v2` 和 `engine.parameter_plan.v2`。
- 根据当前模型和 `SemanticAxisProfile` 生成可执行 parameter plan。
- 按音频和 turn 上下文决定动作启动时机。
- 组织动作增强、动作优化、连贯优化等模块。
- 输出 diagnostics，帮助调参和定位问题。

ModelEngine 不负责：

- WebSocket 协议收发。
- Adapter envelope 构造。
- 文本和音频 release 决策。
- Live2D SDK 渲染细节。
- 动作库编辑器 UI。
- 后端 history / motion tuning 样本存储。

动作库 / 调参面板可以向 ModelEngine 发测试请求，但不绕开引擎直接改运行时事实。

表情冷启动示例的边界：

- 来源是后端模型扫描阶段产出的模型能力事实。
- 数据形态是语义化表情示例，不是原始 `exp3.json` 参数表。
- 不并入 `motion_tuning_samples`。
- 不通过 Adapter 新增专用表情协议。
- 只作为 compile 时的补充参考，不直接写 Live2D 原始参数。

## 4. 当前代码分层

当前 `frontend/src/model-engine/` 文件职责如下：

| 文件 | 当前职责 | 结构方向 |
| --- | --- | --- |
| `useModelEngine.ts` | 引擎 facade：持有状态、装配 runtime 与 start 依赖、暴露对外 API | 保持为组合入口 |
| `runtime/motionRuntimeScheduler.ts` | pending queue、等待音频起播、过期清理、启动时机调度 | 保持为 runtime scheduler |
| `runtime/motionStart.ts` | payload 启动、compile 触发、playPlan 调用、启动结果写回 | 保持为 runtime start boundary |
| `normalize.ts` | `motion_intent.v2` 和 `parameter_plan.v2` 入站归一化 | 保留为边界 parser |
| `planParser.ts` | `parameter_plan.v2` parser / clone | 归入 contracts/parsers |
| `compiler/compileMotionIntent.ts` | compile 主入口，负责装配 pipeline 和收口结果 | 保持为 compiler 主入口 |
| `compiler/compileContext.ts` | compile 共享上下文与 state 定义 | 保持为 stage 公共协议 |
| `compiler/contracts.ts` | compile 输入输出契约、timing/diagnostics/result 类型 | 保持为 compile 契约层 |
| `compiler/pipeline.ts` | stage 顺序执行器 | 保持轻量 |
| `compiler/diagnostics.ts` | compile diagnostics 构造与收口 | 按 stage 聚合 |
| `compiler/stages/*.ts` | 各阶段编译逻辑 | 保持单一职责 |
| `runtime/contracts.ts` | runtime 调度、启动、状态控制、依赖端口类型；session 查询端口按 `turnId` 暴露 | 保持为 runtime 契约层 |
| `timing.ts` | timing resolution，支持 hint/audio_sync/default | 作为 timing stage |
| `settings.ts` | 强度倍率设置 | 改为 profile-aware settings |
| `contracts.ts` | 入站动作 payload 归一化后的边界类型 | 保持为 payload boundary 契约层 |
| `constants.ts` | 默认时长、等待窗口、参数轴常量 | 拆分协议常量和 runtime 策略常量 |

## 5. 目标分层方案

前端 ModelEngine 分为下面几层：

```text
ModelEngine
  EngineFacade
  EngineRuntime
  PayloadBoundary
  CompilePipeline
    IntentValidator
    AxisResolver
    IntensityStage
    CouplingStage
    SpeechPoseStage
    ExpressionStage
    ContinuityStage
    TimingStage
    PlanBuilder
  ExtensionRegistry
  Diagnostics

AvatarRuntime
  ParameterPlanPlayer
  AmbientRuntime
  CubismPhysics
```

### 5.1 EngineFacade

目标位置：

```text
frontend/src/model-engine/useModelEngine.ts
```

职责：

- 对 `usePetDesktopController` 暴露稳定 API。
- 组合 runtime、compiler、player、settings。
- 维护引擎状态 projection。

不负责：

- 编译细节。
- session segment 结构细节。
- 具体动作增强模块实现。

### 5.2 EngineRuntime

职责：

- 管理 pending motion payload。
- 等待音频起播或超时启动。
- 根据 turn/message/playbackTurn 上下文取消过期 payload。
- 触发 play plan。

当前落地：

```text
runtime/motionRuntimeScheduler.ts
runtime/motionStart.ts
```

目标接口：

```ts
interface MotionRuntimeScheduler {
  enqueue(payload, context): void;
  notifyAudioStarted(context): void;
  notifyTurnChanged(turnId): void;
  stop(reason): void;
}
```

### 5.3 PayloadBoundary

职责：

- `engine.motion_intent.v2` parse 为 `SemanticMotionIntent`。
- 前端内部执行使用的 `engine.parameter_plan.v2` parse 为 `SemanticParameterPlan`。
- 对未知 schema 明确拒绝。

目标文件：

```text
model-engine/payload/
  normalizeMotionPayload.ts
  parseParameterPlan.ts
```

原则：

- 入站边界接收 `unknown`。
- 内部 pipeline 只接收已归一化类型。
- parser 不做动作语义决策。

### 5.4 CompilePipeline

职责：

把 `SemanticMotionIntent` 编译为 `SemanticParameterPlan`。

目标 pipeline：

```text
SemanticMotionIntent
-> IntentValidator
-> AxisResolver
-> IntensityStage
-> CouplingStage
-> SpeechPoseStage
-> ExpressionStage
-> ContinuityStage
-> TimingStage
-> PlanBuilder
-> SemanticParameterPlan
```

stage 形态：

```ts
interface MotionCompileStage {
  id: string;
  run(context: MotionCompileContext): MotionCompileStageResult;
}
```

stage 规则：

- 第一轮使用静态顺序，不引入 `order`
- 不播放动作。
- 不访问 WebSocket。
- 不直接写 UI 状态。
- 所有派生结果进入 compile context。
- 所有调整输出 diagnostics。

compile state 值层约束：

| 字段 | 含义 | 谁可以写 |
| --- | --- | --- |
| `controlledValues` | 用户/LLM 直控输入层，表示原始 intent 在通过 profile 过滤、保护性归一化和强度处理后的可控轴值 | `AxisResolver`、`IntensityStage` |
| `derivedValues` | 引擎派生层，表示 coupling、speech pose、expression、continuity 等 stage 追加出来的派生轴值 | 派生型 stage |
| `allAxisValues` | 最终编译输入层，表示进入 mode/timing/plan build 的最终轴值全集 | 负责汇总的 stage |

约束规则：

- `controlledValues` 不允许被派生型 stage 回写。
- `SpeechPoseStage`、`ExpressionStage`、`ContinuityStage` 这类增强 stage 默认只产生派生值。
- `allAxisValues` 是最终消费层，不是原始输入层。
- 后续新增 stage 时，必须先明确自己写的是 `controlledValues`、`derivedValues` 还是 `allAxisValues`。
- 如果一个 stage 不是“解释用户原始输入”，就不应该改写 `controlledValues`。

### 5.5 ExtensionRegistry

ExtensionRegistry 是第二轮之后的能力挂载入口。

建议先做静态 registry：

```ts
interface ModelEngineExtension {
  id: string;
  kind: "compile_stage" | "runtime_stage" | "diagnostic";
  enabled(settings, model): boolean;
}
```

核心 stages：

```text
intentValidator
axisResolver
intensity
coupling
modeResolver
timing
planBuilder
```

可选 stages：

```text
speechPose
expressionFromDialogue
continuity
lipSync
```

## 6. 关键能力模块

### 6.1 AxisResolver

职责：

- 根据 `SemanticAxisProfile.axes` 判断哪些轴允许 LLM 控制。
- `primary` / `hint` 可以从 intent 进入。
- `derived` / `runtime` / `ambient` / `debug` 不由 LLM 直接写入。
- 对原始轴值做第一轮保护性归一化，包括有限数校验和按轴范围 clamp。

### 6.2 IntensityStage

职责：

- 应用整体动作强度。
- 应用单轴强度。
- 处理 expressive / idle 模式差异。
- 从 profile axes 派生可调轴列表。
- 对强度缩放后的结果做第二轮范围保护，避免缩放后越界。

### 6.3 CouplingStage

职责：

- 根据 profile couplings 做语义轴联动。
- 只做当前动作的参数补偿。
- 输出触发、clamp、跳过原因。

目标文件：

```text
model-engine/stages/couplingStage.ts
```

### 6.4 SpeechPoseStage

职责：

- 让说话时人物不只动嘴和头。
- 根据音频时长、turn 状态、动作 mode，为头部和身体提供轻量说话姿态。

第一阶段范围：

- 只做 plan 级增强。
- 不做音频 RMS。
- 不做 phoneme / viseme。
- 不做逐帧口型。

输入：

```text
messageId
turnId
playbackTurnId
targetDurationMs
payloadKind
mode
```

### 6.5 ExpressionStage

职责：

- 根据用户对话、assistant 回复、emotion_label、semantic axes 判断面部表情倾向。
- 输出表情相关 semantic axis 或 expression hint。

边界：

- 不放进 Adapter。
- 不让 LLM 直接控制 Live2D 参数。
- 作为 ModelEngine 可选 compile stage。

初期输入：

- `emotion_label`
- 当前 semantic axes
- 最近 assistant text / user text 的轻量上下文
- 当前模型提供的表情冷启动示例库

表情冷启动示例规则：

- 示例来源分层为 `user` -> `model_native` -> `default`。
- 优先使用用户确认过的动作/表情样本。
- 当用户样本为空，或核心类别覆盖不足时，按缺失类别补入模型冷启动示例。
- 补齐是补缺，不覆盖已有用户样本。
- 最小可用覆盖优先保证 `neutral`、`happy`、`angry`、`surprised` 和一个补充情绪类。
- Action Lab 显示的 few-shot 有效示例预览应直接反映后端当前实际解析结果，而不是前端独立重算的平行结果。

表情冷启动示例的抽象规则：

- 先从模型原生 expression 扫描结果抽取候选信息。
- 再映射到 `SemanticAxisProfile` 认可的 semantic axes。
- 只进入 `primary` 和可接受的 `hint` 轴。
- `derived`、`runtime`、`ambient`、`debug` 不作为示例主输入。
- `mouth_open` 这类 runtime-owned 轴不作为静态表情示例主控制项。

### 6.6 ContinuityStage

职责：

- 解决连续多段回复之间动作跳变。
- 根据上一段 plan、当前 plan、音频剩余时间做 soft handoff 优化。
- 输出 handoff 策略和 diagnostics。

### 6.7 LipSyncStage

职责：

- 把口型从静态 plan 中拆出，交给实时口型层。

执行顺序：

```text
compile pipeline / speech pose / continuity
-> lip sync runtime
```

## 7. 参数所有权

长期所有权按 axis role 划分：

| 角色 | 谁主导 | 说明 |
| --- | --- | --- |
| `primary` | LLM intent | 当前动作的主要语义表达 |
| `hint` | LLM intent | 可选提示，不保证完整 |
| `derived` | Engine stage | coupling / speech pose / expression 等派生 |
| `runtime` | Avatar runtime | blink、lip sync、物理响应等运行时写参 |
| `ambient` | Ambient runtime | 待机、呼吸、空闲动作 |
| `debug` | 工具/诊断 | 不进入主播放链路 |

原则：

- LLM 不直接写 `derived/runtime/ambient/debug`。
- Engine 可以生成 `derived`。
- Avatar runtime 可以写 `runtime/ambient`，但需要和当前 plan 有优先级协调。
- 所有非原始 intent 的修改都要有 diagnostics。

compile state 和参数所有权的对应关系：

- `controlledValues` 对应当前动作里由 LLM / 用户直控进入的 `primary`、`hint` 层。
- `derivedValues` 对应当前动作里由引擎内部模块补出来的 `derived` 层。
- `allAxisValues` 是 parameter plan 编译前的最终汇总视图，不单独代表新的所有权层。

compile diagnostics 中 derived 轴字段的语义：

- `availableDerivedAxes` 表示当前 profile 静态定义的 `derived` 轴。
- `appliedDerivedAxes` 表示本次编译实际由 stage 写入的 `derived` 轴。
- `derivedAxes` 保留为当前实际应用的 derived 轴列表，语义等同于 `appliedDerivedAxes`。

## 8. 和外部模块的边界

### Adapter

Adapter 负责：

- 收协议。
- 校验 envelope。
- 归一化 payload。
- 把 motion payload 交给 Turn Playback / ModelEngine。

Adapter 不负责：

- 选择动作效果。
- 编译 semantic axis。
- 判断表情。

### Turn Playback

Turn Playback 负责：

- 文本、音频、动作挂到同一 segment。
- 决定什么时候释放 motion payload 给 ModelEngine。

Turn Playback 不负责：

- 编译动作计划。
- 优化动作参数。

### Action Lab / 调参工具

工具层负责：

- 展示动作库、semantic profile、couplings、diagnostics。
- 发起 preview。
- 辅助调参。

工具层不负责：

- 绕开 ModelEngine 直接变更主运行时事实。

### Avatar Runtime

Avatar Runtime 负责：

- 执行 parameter plan。
- Live2D 参数写入。
- Cubism physics。
- ambient / idle。

Avatar Runtime 不负责：

- 理解语义轴。
- 判断表情语义。
- 连接后端。

## 9. 推荐实施顺序

### Phase 0：文档与代码审阅

目标：

- 确认 `model-engine/` 主路径。
- 标记废弃入口残留和冗余命名。
- 建立本文件作为主设计入口。

验收：

- 当前协议、边界和分层清晰。
- 文档只描述当前事实和目标结构。

### Phase 1：协议边界与冗余清理

目标：

- 搜索 `legacy`、`compat`、多版本 fallback、非主路径 payload。
- 删除服务废弃入口的旧回退逻辑。
- 保留当前同步策略和边界校验。

注意：

- audio wait fallback 属于当前同步策略。
- runtime parser 属于当前边界保护。

### Phase 2：拆 Compiler Pipeline

目标：

- 把 compile 主链拆成 stage。
- 先拆纯函数，不改变行为。

建议文件：

```text
model-engine/compiler/
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

当前状态：

- 本阶段已经完成
- compiler 对外入口保持不变
- 现有 compile 相关验证已经通过

### Phase 3：引入 ExtensionRegistry

目标：

- 支持静态注册 compile stages。
- 每个 stage 有 id、顺序、开关、diagnostics。
- 为 speech pose、expression、continuity 预留插槽。

### Phase 4：SpeechPoseStage

目标：

- 先做轻量说话姿态。
- 只影响当前 plan，不做逐帧口型。
- 输出可调参数和 diagnostics。

### Phase 5：ExpressionStage

目标：

- 根据对话和 emotion 判断当前面部表情倾向。
- 先输出 semantic axis / expression hint，不直接写 Live2D 参数。

### Phase 6：ContinuityStage

目标：

- 基于上一段动作记录做 soft handoff 优化。
- 减少连续回复中的动作跳变。

### Phase 7：LipSyncStage

目标：

- 研究 RMS / phoneme / viseme。
- 建立实时口型和 plan 参数的优先级关系。

## 10. 当前优先审阅点

下一次进入代码前，优先看这些点：

1. `ExtensionRegistry` 是否先做静态注册，不急着做复杂插件系统。
2. 新增 stage 如何声明自己的输入、输出、开关和 diagnostics。
3. `SpeechPoseStage` 第一版只做 plan 级轻量说话姿态，不碰逐帧口型。
4. `ExpressionStage` 如何消费 emotion、语义轴和表情冷启动示例。
5. `ContinuityStage` 如何拿到上一段 plan / 播放上下文，避免直接耦合 runtime 内部结构。
6. `settings.ts` 是否需要增加面向增强 stage 的开关和强度参数。

## 11. 设计原则

- 当前只支持 v2 主路径。
- 废弃入口回退分支不进入工作文档主叙述。
- 模块先按职责拆，不先追求复杂插件系统。
- 扩展通过 stage / registry 挂载。
- 每个 stage 都要有明确输入、输出、diagnostics。
- 不让 Adapter、Turn Playback、Avatar Runtime 承担引擎语义。
- 先做 plan 级增强，再做逐帧 runtime 增强。
- 默认参数保守，先保证自然，再追求表现力。
