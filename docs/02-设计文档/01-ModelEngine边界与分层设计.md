# ModelEngine 边界与分层设计

本文定义前端动作引擎当前成立的职责、依赖和扩展规则。

## 1. 定位

ModelEngine 是语义动作编译器和动作启动边界。它把动作意图编译成当前 Live2D 模型可以执行的参数计划，或解析成受控资源执行计划。

```text
engine.motion_intent.v4
  -> ModelEngine compiler
  -> engine.parameter_plan.v3 / typed resource execution
  -> PlaybackTimeline motion sink
  -> Live2D WebSDK
```

正式对话与官方 `<@anim>` 兼容入口只产生 `engine.motion_intent.v4`。手动预览不构造协议 intent，而是保存并重放第一阶段编译结果 `CompiledSemanticMotion`。

## 2. 职责

ModelEngine 负责：

- 严格归一化动作 payload。
- 校验模型、profile id/revision 和动作 schema。
- 将 v4 `axis_levels` 转换成模型级语义轴值。
- 执行强度、派生、说话手势和轴关系图计算。
- 解析 segment-scoped Timeline 时钟与动作 timing。
- 生成 `engine.parameter_plan.v3`。
- 仲裁 typed expression/motion resource。
- 启动动作并把真实 started/terminal 结果报告给 Timeline。
- 生成可归因的 compile diagnostics 和 Motion Feedback。

ModelEngine 不负责：

- WebSocket 收发和协议 envelope 聚合。
- 文本、音频和字幕的 release 决策。
- 创建或伪造音频时钟。
- 直接操作 SessionStore 的业务事实。
- TTS、音频下载或 WebAudio 采样。
- Live2D 模型加载、渲染循环和物理求解。
- 动作实验室数据持久化。

## 3. 外部契约

| 输入 | 用途 |
| --- | --- |
| `engine.motion_intent.v4` | Persona Effect 主动作；九级 `axis_levels` |
| `CompiledSemanticMotion` | ModelEngine 第一阶段输出，也是手动预览唯一输入 |
| `engine.parameter_plan.v3` | 已完成语义编译并携带参数响应策略的内部/工具计划 |
| `MotionPlaybackClockContext` | 当前 segment 的窄时钟投影 |
| model summary/profile/catalog | 当前模型能力事实 |

| 输出 | 用途 |
| --- | --- |
| parameter plan | 交给 Live2D 参数播放器 |
| typed resource execution | 交给 expression/catalog motion player |
| compile diagnostics | 记录每阶段输入、输出与约束 |
| started/terminal callback | 推进当前 Timeline motion sink |

生产动作必须携带非空 `turn_id + message_id`。preview 是明确的工具入口，不复用生产段身份。

## 4. 目录职责

| 位置 | 职责 |
| --- | --- |
| `useModelEngine.ts` | facade 与实例组合根 |
| `normalize.ts` | V4 motion intent 与 typed catalog motion 的严格入站解析 |
| `planParser.ts` | `engine.parameter_plan.v3` 严格解析 |
| `compiler/compileParameterMotionIntent.ts` | 参数动作 compiler 主入口与两阶段结果收口 |
| `compiler/compileContext.ts` | stage 共享 state |
| `compiler/registry.ts` | 实例级 stage registry |
| `compiler/stages/` | 各阶段的唯一实现 |
| `runtime/motionRuntimeScheduler.ts` | pending ownership 与启动条件 |
| `runtime/motionStart.ts` | compile、player 启动和结果报告 |
| `runtime/playbackClock.ts` | Timeline 时钟投影、剩余可用时长与 performance curve 时钟条件求解 |
| `timing.ts` | 动作 timing 求解 |
| `settings.ts` | 用户强度设置 |

## 5. Compiler Pipeline

真实顺序由 `compiler/registry.ts` 定义：

```text
IntentValidator                 10 core
-> AxisResolver                20 core
-> IntensityStage              30 core
-> SemanticAxisRelationGraph   40 core
-> ModeResolverStage           45 core
-> TimingStage                 46 core
-> CompiledSemanticMotion
-> SpeechPoseStage             60 extension
-> ModelParameterBindingStage 80 core
-> ResourcePolicyStage         90 core
```

| Stage | 所有权 |
| --- | --- |
| `IntentValidator` | schema、模型与 profile 一致性 |
| `AxisResolver` | 等级锚点和确定性区间采样 |
| `IntensityStage` | 整体与单轴强度 |
| `SemanticAxisRelationGraph` | 派生、范围和有界比例约束 |
| `ModeResolverStage` | idle/expressive 判定 |
| `TimingStage` | duration 与时钟 timing |
| `SpeechPoseStage` | 在语义轴结果收口后生成 `speech_gesture_track` |
| `ModelParameterBindingStage` | 语义轴和说话轨道到 Live2D 参数映射 |
| `ResourcePolicyStage` | typed resource 校验与执行仲裁 |

核心阶段不能在运行时禁用或卸载。扩展阶段必须声明顺序和输入输出，不得绕过 pipeline 修改最终计划。

## 6. Compile State

| 字段 | 含义 | 主要写入者 |
| --- | --- | --- |
| `controlledValues` | 模型直接表达并完成锚点/强度处理的轴值 | AxisResolver、IntensityStage |
| `derivedValues` | 关系图产生的语义轴派生值 | `SemanticAxisRelationGraph` |
| `allAxisValues` | 进入关系图与 CompiledSemanticMotion 的合并视图 | state helpers、关系图 |
| `axisValueSources` | 每个值的来源 | 所有写值 stage |
| `relationEvaluations` | 每条关系边的计算结果 | 关系图 |
| `relationAdjustments` | 实际发生的约束 | 关系图 |

规则：

- 派生 stage 不覆盖已明确输入的轴，除非关系图规则明确拥有该约束。
- 每个最终值必须有来源；缺少来源时编译失败。
- 关系约束只执行一次，Adapter 和 WebSDK 不重复处理。
- diagnostics 是可观测结果，不参与播放成功判断。

## 7. 参数所有权

| 角色 | 所有者 | 示例 |
| --- | --- | --- |
| `primary` | LLM intent | 头、身体、主要视线 |
| `hint` | LLM intent | 眉毛、嘴角等细节 |
| `derived` | ModelEngine | 关系图、说话手势 |
| `runtime` | Live2D runtime | 口型、逐帧 speech energy |
| `ambient` | Live2D runtime | 呼吸、待机 |
| `debug` | 工具 | 手动预览和诊断 |

LLM 不写 `derived/runtime/ambient/debug`。Live2D runtime 不重新解释 `axis_levels`，也不猜测语义关系。

## 8. 九级强度与关系图

每个模型通过 `SemanticAxisProfile` 独立定义 neutral、soft/strong/extreme ranges、level anchors、hard range 和 parameter bindings。

ModelEngine 先把 `-4..4` 等级确定性采样为轴值，再由关系图计算组合约束。头身可以同向，也可以有限反向；身体幅度通常比头部小，但合法范围内的反向表达不会被强制改成同向。

详细契约见 [动作参数处理与轴关系图](./13-动作参数处理与轴关系图.md)。

## 9. 说话手势

`SpeechPoseStage` 是 compile extension。它根据 `ag99.voice_following_profile.v3`、segment identity 和音频时长生成按语义轴登记的确定性 `speech_gesture_track`。V3 只提供 semantic axis、相对 `max_speech_offset` 的有效幅度比例和跟随延迟；参数绑定、范围和动力学由 `ModelParameterBindingStage` 统一处理。

当前实现读取 canonical assistant text、标点、短语长度和真实音频时长，生成确定性的非周期 phrase 轨道；
它已经不再从四套整段固定控制点中选择。当前仍没有 TTS phoneme 或声学停顿的显式时间戳，因此 phrase
只是在统一音频时长内进行文本驱动的相对编排，不应描述成逐字或逐音素同步。当前职责分散点与
统一编排目标见 [角色表演主流程与编排职责审计](./19-角色表演主流程与编排职责审计.md)。

职责边界：

- ModelEngine 决定控制点、轨迹极性、延迟和动作幅度。
- PlaybackTimeline 提供真实音频时钟和时长。
- Live2D WebSDK 按轨迹和实时 speech energy 逐帧插值。
- lip-sync sink 独立生成 mouth value；说话手势不能代替口型。

## 10. Timing

有音频的动作只能使用匹配 `turn_id + message_id` 的真实 AudioElement clock。明确无音频的 motion-only segment 可以使用自己的 synthetic clock。

动作计划的进入、保持和退出由 `TimingStage` 在编译时确定；sequence 的最小过渡预算与 keyframe
时间只在 `compileModelParameterPlan.ts` 内按参数动力学计算。`runtime/playbackClock.ts` 不再改写
已编译计划，Live2D player 也不在播放时重写 timing。

Performance curve 是可选 hint：

- hint 不存在时使用动作自身合法 timing。
- hint 存在且时钟可用时按剩余音频时长求解。
- hint 无法应用时记录明确 skipped 原因并移除该 hint。
- 不等待曲线，不伪造时钟，不建立第二条播放链。

## 11. Resource Policy

- expression resource 在参数所有权无冲突时与 parameter plan 叠加。
- motion resource 是完整动作，替代普通 parameter plan。
- 两类资源不能同时选择。
- 资源不存在、类型错误、不可播放或所有权冲突时，本段动作失败。
- 资源执行仍使用当前 Timeline motion sink。

## 12. 启动与终态

ModelEngine 只有在 player 同步报告非空 run id 并调用 started callback 后，才能报告动作已开始。compile 失败、模型未 ready、player 拒绝或资源未实际启动都必须形成失败终态。

一个生产 payload 只能被当前 segment 消费一次。中断、模型替换和 soft handoff 都必须按 `turn_id + message_id + run_id` 结算所有权。

## 13. 扩展规则

新增能力前必须明确：

1. 它处理语义值、timing、资源还是逐帧表现。
2. 是否已有 stage 或 runtime 拥有同类规则。
3. 读取和写入哪些 compile state 字段。
4. 失败是否影响 required motion sink。
5. diagnostics 如何记录来源和调整。

可挂载不等于可以重复实现。相同规则必须只有一个主要所有者。

## 14. 运行验收

基础 smoke 只检查协议输入输出。真正验收需要在一次实时对话中确认：

- v4 intent 与当前 profile 匹配。
- 每个 stage 的输入、输出和来源可追踪。
- 关系图约束与最终 parameter plan 一致。
- Timeline 使用匹配 segment 的真实时钟。
- player 实际报告 started，并在 WebSDK 帧循环中写入参数。
- terminal outcome 回到同一个 motion sink 和 Motion Lab 记录。
