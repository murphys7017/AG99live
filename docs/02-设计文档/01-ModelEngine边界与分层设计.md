# ModelEngine 边界与分层设计

## 定位

ModelEngine 是前端从 `engine.motion_intent.v4` 到可执行参数计划或已校验动作资源的唯一编译边界。它使用当前模型的 `SemanticAxisProfile`，把模型无关的动作语义转换为对该模型可解释、可追踪的运行输入。

```text
motion intent
  -> 严格校验
  -> 语义轴具体值校验与标准化
  -> 关系图、表演时序和说话随动
  -> 参数绑定与响应设置
  -> engine.parameter_plan.v3 / motion resource
  -> Live2D runtime
```

## 输入与输出

| 输入 | 输出 |
| --- | --- |
| 稀疏 `motion_steps[].axis_values` 或 `motion_resource_id` | `engine.parameter_plan.v3` 或预检通过的 motion resource。 |
| 当前模型、profile、语音随动资料、音频时钟和文本 | 计划时序、参数轨道、诊断和可观测终态。 |
| Motion Lab 重放请求 | 复用同一编译和执行路径，不创建实验室专用播放器。 |

ModelEngine 不接收原始 Persona 文本，不修改后端输出，不读取 WebSocket 消息，也不创建第二个播放时钟。

前端素材组合器是 ModelEngine 之前的本地动作意图生成层。它读取 Adapter 同步的 `motion_material_catalog.v1`、`parameter_action_library.v2` 和当前 Profile，输出现有 `engine.motion_intent.v4` 的 `motion_steps`。组合器不直接写入参数，也不绕过 ModelEngine 的范围、关系图和资源校验。

## 编译职责

1. 验证 schema、模型、profile revision、轴名、具体数值和执行形态。
2. 对合法的 `value_range` 内语义值进行标准化，并按 profile 映射为模型值。
3. 应用语义轴关系图，生成派生值和模型约束后的结果。
4. 根据音频或显式时长编排 pose、sequence、gaze、face、speech cues 和收势时间。
5. 生成参数轨道、激活时间、keyframe、语音调制和响应策略。
6. 将诊断、摘要和来源保留给 Motion Lab 与运行日志。

动作资源仍经过 ModelEngine 预检。模型未就绪、资源不存在或前一运行无法结算时，候选会被拒绝，不能改变当前运行的状态。

## 运行与参数融合

ModelEngine 在 Timeline 已建立段时钟后开始动作。Live2D runtime 的 `ActiveParameterMixer` 以 Cubism 当前基值为基础融合 Direct Plan、思考随动、语音随动和合法运行贡献；`ParameterPresentation` 对结果应用响应策略。前景动作只接管重叠参数，口型保持最高优先级，不通过启动动作时清空其他贡献来完成切换。

计划自然结束时，Direct Plan 的所有权按既有收束规则回到当前 Cubism 基值。这个过程不冻结环境动作，也不依赖额外 timeout。

## 本地交互动作

思考摇摆和 speech-only 动作也通过 ModelEngine 形成受控贡献。正式回复动作通过参数优先级接管重叠通道，思考摇摆在 Turn 终态或中断时进入释放，不能替代语义动作或建立独立的播放器。

素材组合动作沿用相同的编译和释放路径。当前五个第一版配方只生成三步短计划，`AmbientActionScheduler` 负责空闲窗口的来源选择和冷却，`AmbientActionDirector` 收口环境候选的基础准入和渐出释放，`ActiveParameterMixer` 负责多个环境计划与对话表现的参数级融合。

## 不变量

- Adapter 是动作输入的验证与运输边界；它不计算参数。
- PlaybackTimeline 是时钟边界；ModelEngine 不拥有音频或段完成协议。
- Live2D runtime 是逐帧表现边界；它不反向解释 `motion_steps`。
- Cubism Framework / Core 只处理最后写入后的模型、Physics 和绘制。
- 编译失败必须可见，不能被修复成默认动作。

动作输入细节见[动作语义与参数编译](04-动作语义与参数编译.md)，播放边界见[播放同步编排设计](../01-架构与结构/04-播放同步编排设计.md)。
