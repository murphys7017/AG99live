# ModelEngine 边界与分层设计

本文是前端动作引擎的当前维护入口，只描述现在成立的边界、结构和扩展规则。

## 1. 定位

ModelEngine 是前端的动作语义编译与启动模块。

它接收当前协议中的动作载荷，将 `engine.motion_intent.v2` 编译为 `engine.parameter_plan.v2`，再把参数计划交给 Live2D 参数播放器执行。

主链路：

```text
engine.motion_intent.v2 / engine.parameter_plan.v2
-> normalizeMotionPayload / parseSemanticParameterPlan
-> useModelEngine
-> motionRuntimeScheduler
-> motionStart
-> compileMotionIntent
-> motionPlayer.playPlan
-> Live2D runtime
```

有效动作协议：

| Payload | Schema | 说明 |
| --- | --- | --- |
| 动作意图 | `engine.motion_intent.v2` | 由语义轴表达动作意图，前端编译为参数计划 |
| 参数计划 | `engine.parameter_plan.v2` | 前端可直接执行的 Live2D 参数计划 |

## 2. 负责什么

ModelEngine 负责：

- 接收已经进入前端运行时的动作 payload。
- 归一化并校验动作意图和参数计划。
- 根据当前模型的 `SemanticAxisProfile` 编译参数计划。
- 根据音频和 turn 上下文决定动作启动时机。
- 通过静态 stage registry 挂载动作增强能力。
- 输出 compile diagnostics，支撑调参、测试和定位问题。

ModelEngine 不负责：

- WebSocket 收发。
- Adapter envelope 构造。
- 文本和音频 release 决策。
- 后端历史和动作调参样本存储。
- Live2D SDK 渲染细节。
- 动作库编辑器 UI。

动作库和调参面板可以向 ModelEngine 发送 preview 请求，但不绕过 ModelEngine 直接改主运行时事实。

## 3. 当前代码分层

当前 `frontend/src/model-engine/` 的文件职责如下：

| 文件 | 当前职责 |
| --- | --- |
| `useModelEngine.ts` | 引擎 facade：持有状态、装配 runtime/start 依赖、暴露对外 API |
| `contracts.ts` | 入站动作 payload 归一化后的边界类型 |
| `normalize.ts` | `engine.motion_intent.v2` 和 `engine.parameter_plan.v2` 入站归一化 |
| `planParser.ts` | `engine.parameter_plan.v2` parser 与 clone |
| `settings.ts` | 动作强度和单轴强度设置 |
| `timing.ts` | motion timing resolution，支持 hint/audio_sync/default |
| `constants.ts` | 默认时长、同步等待窗口和参数轴常量 |
| `runtime/contracts.ts` | runtime 调度、启动、状态控制和依赖端口类型 |
| `runtime/motionRuntimeScheduler.ts` | pending queue、音频起播等待、turn 过期清理和启动时机调度 |
| `runtime/motionStart.ts` | payload 启动、compile 触发、playPlan 调用和启动结果写回 |
| `compiler/contracts.ts` | compile 输入输出契约、timing、diagnostics 和 result 类型 |
| `compiler/compileContext.ts` | compile 共享上下文、中间 state 和 state 写入辅助函数 |
| `compiler/compileMotionIntent.ts` | compile 主入口，创建 context、执行 pipeline、收口结果 |
| `compiler/diagnostics.ts` | compile diagnostics 构造与收口 |
| `compiler/pipeline.ts` | stage 顺序执行器 |
| `compiler/registry.ts` | 静态 compile stage 注册、排序和启用入口 |
| `compiler/stages/*.ts` | 各 compile stage 的具体逻辑 |

## 4. 当前 Compile Pipeline

当前 core pipeline：

```text
IntentValidator
-> AxisResolver
-> IntensityStage
-> CouplingStage
-> ModeResolverStage
-> TimingStage
-> PlanBuilder
```

各 stage 职责：

| Stage | 职责 |
| --- | --- |
| `IntentValidator` | 校验 intent 与当前模型 profile 是否匹配，写入 profile 和 axis map |
| `AxisResolver` | 解析可由 LLM 控制的 primary/hint 轴，过滤 unknown/forbidden/invalid 轴，并做保护性 range clamp |
| `IntensityStage` | 对 expressive 动作应用整体强度和单轴强度，并对缩放后的值再次 clamp |
| `CouplingStage` | 根据 profile couplings 生成 derived 轴值 |
| `ModeResolverStage` | 根据 intent mode 和 idle deadzone 决定最终 `idle/expressive` |
| `TimingStage` | 根据 duration hint、音频剩余时长和默认值解析 timing |
| `PlanBuilder` | 将最终语义轴值映射为 `engine.parameter_plan.v2` 参数列表 |

## 5. Compile State

compile state 是 stage 之间共享的中间状态。新增 stage 必须先明确自己读取和写入哪些字段。

核心值层：

| 字段 | 含义 | 写入者 |
| --- | --- | --- |
| `controlledValues` | LLM/用户直控输入层，来自 primary/hint 轴，经过 profile 过滤、保护性归一化和强度处理 | `AxisResolver`、`IntensityStage` |
| `derivedValues` | 引擎派生层，由 coupling、speech pose、expression 等 compile stage 追加 | 派生型 stage |
| `allAxisValues` | 进入 mode/timing/plan build 的最终汇总视图 | 汇总型 stage |
| `axisValueSources` | 每个轴值的来源，用于 plan parameter source 和 diagnostics | 写入轴值的 stage |
| `appliedDerivedAxes` | 本次编译实际写入的 derived 轴 | `mergeDerivedAxisValues()` |

约束：

- `controlledValues` 只表示当前 intent 的直控语义，不由派生型 stage 改写。
- `derivedValues` 用于引擎内部补偿和增强。
- `allAxisValues` 是最终编译输入视图，不代表新的所有权层。
- `mergeDerivedAxisValues()` 会同步更新 `derivedValues`、`axisValueSources` 和 `appliedDerivedAxes`。
- `refreshAllAxisValues()` 负责把 `controlledValues + derivedValues` 汇总为 `allAxisValues`。

## 6. 参数所有权

长期参数所有权按 semantic axis role 划分：

| 角色 | 主导方 | 说明 |
| --- | --- | --- |
| `primary` | LLM intent | 当前动作的主要语义表达 |
| `hint` | LLM intent | 可选提示，不保证完整 |
| `derived` | Engine stage | coupling / speech pose / expression 等 compile 派生 |
| `runtime` | Avatar runtime | lip sync、blink、物理响应等运行时写参 |
| `ambient` | Ambient runtime | 待机、呼吸、空闲动作 |
| `debug` | 工具/诊断 | 不进入主播放链路 |

规则：

- LLM 不直接写 `derived/runtime/ambient/debug`。
- Engine 可以生成 `derived`。
- Avatar runtime 可以写 `runtime/ambient`，但需要和当前 plan 的优先级协调。
- 所有非直控输入产生的修改都需要进入 diagnostics 或 warnings。

### 6.1 主轴与辅轴设计口径

当前语义轴选择以 Live2D `Motions/*.motion3.json` 的真实参数曲线作为主要参考。

motion 的角色是帮助判断这个模型真实依赖哪些参数形成动作，不直接作为 LLM prompt 示例池，也不要求 LLM 直接触发 motion 文件。ModelEngine 仍然编译语义轴，最终输出 parameter plan。

当前口径：

| 类型 | 含义 | 典型轴 |
| --- | --- | --- |
| 动作主轴 | 构成姿态和动作骨架，决定角色整体动作轮廓和情绪强弱 | `head_yaw`、`head_pitch`、`head_roll`、`body_yaw`、`body_roll`、`body_pitch`、`eye_open_left`、`eye_open_right`、`eye_smile_left`、`eye_smile_right`、`gaze_x`、`gaze_y` |
| 表情辅轴 | 在动作骨架上补充面部表情、态度和细节质感 | `mouth_smile`、`mouth_x`、`brow_bias`、`brow_left_detail`、`brow_right_detail` |
| 运行时轴 | 由音频、口型、呼吸或运行时持续驱动 | `mouth_open`、`breath` |
| 暂缓候选轴 | 先作为 motion 观察材料，不进入第一版主控 | `body_lift`、`body_depth`、`PhyBodyPositionY` 等候选 |

当前判断：

- 头部三轴是 Mk6 motion 中最稳定、最强的动作骨架。
- 身体扭转、倾斜和摇晃应进入动作主轴体系，用于表达情绪强弱、前倾压迫、后缩惊讶、疲惫下垂等整体姿态。
- 第一版用 `body_pitch` 承接身体前倾、后缩、下沉和挺起，优先验证 `BodyAngleY`，不同时暴露多个 `PhyBody*Y` 参数。
- 眼睛开闭是动作主轴的一部分，尤其影响惊讶、疲惫、害羞、眨眼等动作是否成立。
- 眼睛笑意和视线方向第一版也归入动作主轴，用来表达眯眼、笑眼、观察、躲闪和注意力转移。
- 嘴巴开闭属于重要动作轴，但说话场景下主要由 runtime/lip sync 管理，避免和音频口型冲突。
- 嘴角笑意和眉毛主要承担表情态度微调，不应和头身姿态同等主导动作骨架。
- `Anim*`、`Exp*`、`Phy*` 参数只作为 motion 分析材料，不直接进入 LLM 主控轴。

第一版名单维护在 [Motion 主轴/辅轴候选评估表](./06-Motion主轴辅轴候选评估.md)。

## 7. Diagnostics

`CompileDiagnostics` 是动作编译调试入口。

当前关键字段：

| 字段 | 含义 |
| --- | --- |
| `primaryAxes` | 当前 profile 中可由 LLM 主控的轴 |
| `hintAxes` | 当前 profile 中可由 LLM 提示控制的轴 |
| `availableDerivedAxes` | 当前 profile 静态定义的 derived 轴 |
| `appliedDerivedAxes` | 本次编译实际由 stage 写入的 derived 轴 |
| `derivedAxes` | 当前实际应用的 derived 轴，语义等同于 `appliedDerivedAxes` |
| `runtimeAxes` | 当前 profile 中 runtime/ambient/debug 轴 |
| `missingAxes` | 未提供的 primary 轴 |
| `forbiddenAxes` | LLM 尝试写入但角色不允许的轴 |
| `invalidAxes` | 未知或非法值的轴 |
| `compiledParameters` | 本次 plan 生成的参数 ID |
| `intensityApplied` | 本次 expressive 动作是否实际应用强度缩放 |

## 8. 静态 Stage Registry

`compiler/registry.ts` 是当前 compile stage 的唯一装配入口。

注册项：

```ts
interface ModelEngineCompileStageRegistration {
  id: string;
  stage: MotionCompileStage;
  order: number;
  kind: "core" | "extension";
  enabled(context: MotionCompileContext): boolean;
}
```

当前注册的 core stages：

```text
intentValidator  order 10
axisResolver     order 20
intensity        order 30
coupling         order 40
modeResolver     order 50
timing           order 60
planBuilder      order 70
```

registry 规则：

- `compileMotionIntent()` 只调用 `resolveCompileStages(context)`，不直接 import 各 stage。
- `pipeline.ts` 只负责按顺序执行 stage 和失败短路。
- `MotionCompileStage` 不携带 registry metadata。
- extension stage 通过 `kind: "extension"` 和独立 `order` 接入。
- `enabled(context)` 是静态开关入口，当前 core stage 始终启用。
- 不做动态插件加载，不读取外部插件配置，不新增协议字段。

## 9. 扩展 Stage 规则

新增 stage 必须满足：

1. 通过 `compiler/registry.ts` 注册。
2. 明确 `id`、`kind`、`order` 和 `enabled(context)`。
3. 文件顶部声明 Reads / Writes / Does not own。
4. 不播放动作，不访问 WebSocket，不直接写 UI 状态。
5. 默认写入 `derivedValues` 或专属派生结果，不覆盖 `controlledValues`。
6. 输出 diagnostics 或 warnings，让调试者知道能力是否应用。
7. 不改变 `compileMotionIntent()` 对外接口。

当前扩展顺序：

| 能力 | 入口 | 边界 |
| --- | --- | --- |
| `SpeechPoseStage` | compile registry extension | plan 级轻量说话姿态，不做逐帧口型 |
| `ParameterPresentationLayer` | Live2D Web SDK / avatar runtime 侧连续表现层 | 持续运行，负责惯性、衰减、残留、soft handoff、层间混合和逐帧输出 |
| `LipSyncStage` | avatar runtime / audio runtime 协同 | 处理 RMS、phoneme、viseme 与参数计划的优先级 |

## 10. SpeechPoseStage

`SpeechPoseStage` 是当前最适合作为第一个 extension 的能力。

目标：

- 让说话时人物拥有轻量的头部、身体或肩部姿态。
- 只做 plan 级增强。
- 不做音频 RMS、phoneme、viseme 或逐帧口型。
- 不直接写 Live2D 原始参数。
- 不修改 `controlledValues`。

接入位置：

```text
CouplingStage
-> SpeechPoseStage
-> ModeResolverStage
```

建议注册：

```text
id: "speechPose"
kind: "extension"
order: 45
```

详细规则维护在 [SpeechPoseStage 设计](./04-SpeechPoseStage设计.md)。

## 11. 表情与 Expressions 边界

表情表现由语义轴和 Live2D 参数计划表达，不从 `Expressions/*.exp3.json` 生成主轴、prompt 示例或动作参考池。

当前规则：

- LLM 只面向当前 `SemanticAxisProfile` 中允许控制的语义轴。
- 表情态度主要通过 `mouth_smile`、`brow_bias`、`gaze_x`、`gaze_y` 等辅轴表达；需要姿态配合时再组合头部和身体主轴。
- `Expressions/*.exp3.json` 属于模型作者预制的触发或叠加效果，不进入 ModelEngine compile pipeline。
- 后续如果需要重新接入原生 expression，必须作为独立能力重新设计，不能混入主轴来源。

## 12. Motion 与主轴选择边界

Live2D `Motions/*.motion3.json` 是当前选择动作主轴的重要参考来源。

当前使用原则：

- motion 用于观察真实参数曲线、幅度、方向、持续时间和联动关系。
- motion 用于辅助判断哪些参数适合作为动作主轴、表情辅轴、运行时轴或候选派生轴。
- motion 不直接替代 ModelEngine 的语义轴编译，不作为协议载荷，不作为 LLM 必须输出的动作名称。
- motion 中的物理、动画、表达式开关类参数不直接暴露给 LLM 主控。
- 后续优化默认 profile 时，应优先根据 motion 统计校准轴角色，再调整 prompt 和调参工具展示。

当前 Mk6 观察结论：

- `ParamAngleX/Y/Z` 是最可靠的头部动作主干。
- `ParamBodyAngleX/Z` 是身体扭转和摇晃的重要依据。
- `BodyAngleY` 是第一版 `body_pitch` 的优先验证参数；`PhyBodyPositionY`、`PhyBodyUpperY` 等暂作为观察材料。
- `ParamEyeLOpen`、`ParamEyeROpen`、`ParamEyeLSmile`、`ParamEyeRSmile` 对眼部动作成立有明确贡献，应归入动作主轴体系。
- `ParamEyeBallX/Y` 第一版作为注意力方向主轴，后续可根据生成效果再调整。
- `ParamMouthForm`、`ParamMouthX`、眉毛细节参数更适合作为表情和态度辅轴。

## 13. ParameterPresentationLayer

连续表现层由 SDK 侧 `ParameterPresentationLayer` 承担。

原因：

- 连续性不是 compile 结果本身，而是逐帧运行时事实。
- soft handoff、惯性、衰减、残留和层间混合更适合由 Live2D Web SDK / avatar runtime 侧持续状态处理。
- compile stage 只能看到单次 plan；持续表现层可以读取上一帧真实参数状态和当前运行态上下文。

当前判断：

- `ParameterPresentationLayer` 是连续性主承载层。
- ModelEngine compile 侧只保留必要的 hint 能力，例如目标时长、优先级、是否允许覆盖上一段残留等；这些 hint 不改变现有协议主结构。

`ParameterPresentationLayer` 的目标边界：

- 输入：`engine.parameter_plan.v2`、运行时说话状态、当前 active plan、上一帧表现状态。
- 输出：交给 Live2D runtime 的逐帧连续参数值或增量值。
- 负责：惯性、衰减、残留、soft handoff、idle/talk/action 层混合、必要的参数平滑。
- 不负责：文本理解、动作选择、协议收发、compile pipeline 决策。

当前待办顺序：

1. 先完成 `SpeechPoseStage`，补齐说话时的 plan 级轻量姿态。
2. 再实现 `ParameterPresentationLayer`，承接连续性和逐帧表现。
3. 随后明确参数所有权与层间混合规则，收口 `plan / talk / runtime / ambient / physics` 的叠加边界。
4. 最后补 diagnostics 和高价值时序测试。

## 14. 外部边界

### Adapter

Adapter 负责协议收发、信封校验、入站事件分发和出站消息构建。

Adapter 不负责编译动作计划，不判断动作语义。

### Turn Playback

Turn Playback 负责把文本、音频和动作挂到同一 segment，并决定何时 release 给 ModelEngine。

Turn Playback 不编译动作参数。

### Action Lab / 调参工具

Action Lab 展示动作库、semantic profile、couplings 和 diagnostics，并发起 preview。

Action Lab 不绕开 ModelEngine 改主运行时事实。

### Avatar Runtime

Avatar Runtime 执行 parameter plan、Live2D 写参、物理响应、ambient 和 idle。

Avatar Runtime 不理解语义轴，也不判断表情语义。

## 15. 维护原则

- 当前只支持 v2 主路径。
- 废弃协议回退分支不进入主代码和主文档。
- 模块按职责维护，扩展通过 stage / registry 挂载。
- plan 级增强先于逐帧 runtime 增强。
- 连续性主实现优先放在 `ParameterPresentationLayer`，而不是 compile 阶段做静态补丁。
- 默认参数保守，先保证自然，再追求表现力。
- 主轴选择优先服从 motion 观察到的真实动作骨架，不凭 expression 文件或名称猜测。
- 文档只写当前事实和当前有效设计，不保留历史迁移叙述。
