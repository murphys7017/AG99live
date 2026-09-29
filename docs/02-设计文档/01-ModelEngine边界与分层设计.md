# ModelEngine 边界与分层设计

## 定位

ModelEngine 是前端从 `engine.motion_intent.v4` 到可执行参数计划或已校验动作资源的唯一编译边界。它使用当前模型的 `SemanticAxisProfile`，把模型无关的动作语义转换为对该模型可解释、可追踪的运行输入。

```text
motion intent
  -> 严格校验
  -> 语义轴标准化与九级采样
  -> 关系图、表演时序和说话随动
  -> 参数绑定与响应设置
  -> engine.parameter_plan.v3 / motion resource
  -> Live2D runtime
```

## 输入与输出

| 输入 | 输出 |
| --- | --- |
| `axis_levels`、稀疏 `motion_steps` 或 `motion_resource_id` | `engine.parameter_plan.v3` 或预检通过的 motion resource。 |
| 当前模型、profile、语音随动资料、音频时钟和文本 | 计划时序、参数轨道、诊断和可观测终态。 |
| Motion Lab 重放请求 | 复用同一编译和执行路径，不创建实验室专用播放器。 |

ModelEngine 不接收原始 Persona 文本，不修改后端输出，不读取 WebSocket 消息，也不创建第二个播放时钟。

## 编译职责

1. 验证 schema、模型、profile revision、轴名、等级和执行形态。
2. 对合法的 `-4..4` 语义等级进行确定性采样，并按 profile 范围映射为模型值。
3. 应用语义轴关系图，生成派生值和模型约束后的结果。
4. 根据音频或显式时长编排 pose、sequence、gaze、face、speech cues 和收势时间。
5. 生成参数轨道、激活时间、keyframe、语音调制和响应策略。
6. 将诊断、摘要和来源保留给 Motion Lab 与运行日志。

动作资源仍经过 ModelEngine 预检。模型未就绪、资源不存在或前一运行无法结算时，候选会被拒绝，不能改变当前运行的状态。

## 运行与参数融合

ModelEngine 在 Timeline 已建立段时钟后开始动作。Live2D runtime 的 `ActiveParameterMixer` 以 Cubism 当前基值为基础融合 Direct Plan、语音随动和合法运行贡献；`ParameterPresentation` 对结果应用响应策略。口型保持高优先级，不被动作收势延迟。

计划自然结束时，Direct Plan 的所有权按既有收束规则回到当前 Cubism 基值。这个过程不冻结环境动作，也不依赖额外 timeout。

## 本地交互动作

思考摇摆和 speech-only 动作也通过 ModelEngine 形成受控贡献。它们使用已有参数融合和释放边界，在正式回复动作、终态或中断时交还控制权，不能替代语义动作或建立独立的播放器。

## 不变量

- Adapter 是动作输入的验证与运输边界；它不计算参数。
- PlaybackTimeline 是时钟边界；ModelEngine 不拥有音频或段完成协议。
- Live2D runtime 是逐帧表现边界；它不反向解释 `motion_steps`。
- Cubism Framework / Core 只处理最后写入后的模型、Physics 和绘制。
- 编译失败必须可见，不能被修复成默认动作。

动作输入细节见[动作语义与参数编译](04-动作语义与参数编译.md)，播放边界见[播放同步编排设计](../01-架构与结构/04-播放同步编排设计.md)。
