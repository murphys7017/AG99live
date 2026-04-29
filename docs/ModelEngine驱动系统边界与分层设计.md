# ModelEngine 驱动系统边界与分层设计

> 状态：历史设计文档。当前运行协议已经破坏性收口到 `engine.motion_intent.v2 -> engine.parameter_plan.v2`，不再保留 v1 兼容路径。当前有效状态以 `V2当前实现状态与下一步.md`、`主轴重构计划/README.md` 和 `后端主导数据边界与执行计划.md` 为准。

快照日期：2026-04-26

## 背景

当前项目已经把动作链路的核心边界收敛为：

- 后端/AstrBot adapter 负责接收消息、调用模型、从回复中提取动作意图。
- 前端 `ModelEngine` 负责把动作意图编译为 Live2D 可执行的参数驱动计划。
- Live2D runtime 负责写入参数、执行 Cubism SDK 物理与渲染。

本文件用于固定下一阶段设计共识：`ModelEngine` 不是简单转发 12 个参数，而是把 12 个语义参数扩展为“当前说话动作”的整体 Live2D 驱动计划。

## 核心边界

`ModelEngine` 的当前核心输入是 12 个主参数：

| 分组 | 参数 |
|---|---|
| 头部 | `head_yaw`, `head_roll`, `head_pitch` |
| 身体 | `body_yaw`, `body_roll` |
| 视线 | `gaze_x`, `gaze_y` |
| 眼睛 | `eye_open_left`, `eye_open_right` |
| 嘴 | `mouth_open`, `mouth_smile` |
| 眉 | `brow_bias` |

`ModelEngine` 的目标输出是当前动作的整体参数计划：

```text
engine.motion_intent.v1
-> ModelEngine
-> engine.parameter_plan.v1
-> Live2D runtime
```

本阶段必须明确：

- 12 个参数只描述“当前回复/说话动作”的语义意图。
- 待机动画不并入当前 12 轴动作意图。
- 呼吸、待机、Cubism 物理不是后端职责。
- Live2D runtime 不理解语义，只负责执行最终参数写入和渲染。

## 模块分层

建议长期结构如下：

```text
ModelEngine
  SemanticMotionCompiler
  CouplingEngine
  SpeechPoseEngine
  LipSyncPlanner
  MotionMixer

Live2DRuntime
  DirectParameterPlayer
  AmbientRuntime
  CubismPhysics
```

### SemanticMotionCompiler

职责：

- 接收后端提取的 12 轴 `motion_intent`。
- 校验 schema、mode、emotion、12 轴数值范围。
- 生成基础 `parameter_plan` 骨架。

不负责：

- 播放。
- 逐帧插值。
- 待机动画。
- 直接调用 Live2D SDK。

### CouplingEngine

职责：

- 根据 12 个主参数做自然联动。
- 补足大模型没有显式输出的身体、头部、眼神、眼眉联动。
- 只做当前动作参数修正，不引入待机运动。

第一阶段建议联动：

| 来源参数 | 目标参数 | 方向 | 初始强度 |
|---|---|---|---:|
| `head_yaw` | `body_yaw` | 同向 | `0.30` |
| `head_roll` | `body_roll` | 同向 | `0.25` |
| `gaze_x` | `head_yaw` | 同向 | `0.15` |
| `gaze_y` | `head_pitch` | 同向 | `0.12` |
| `mouth_open` | `head_pitch` | 轻微参与 | `0.08` |
| `mouth_smile` | `eye_open_left/right` | 微笑时轻微收眼 | `0.10` |

原则：

- 只做增量叠加，不覆盖原始轴。
- 小幅变化不联动，建议 deadzone 为 `5~6`。
- 单目标轴联动总增量需要上限，建议首版不超过 `±12`。
- 最终值必须 clamp 到 `0..100`。
- 必须输出 diagnostics，记录哪些轴被联动修改。

### SpeechPoseEngine

职责：

- 让说话时人物不只动嘴和头。
- 基于当前 turn 的说话状态、音频时长、动作模式，为头部和身体提供基础说话姿态。

第一阶段只做 plan 级别静态增强，不做逐帧节奏：

- 说话时 `mouth_open` 可以有基础开口倾向。
- `head_pitch` 可以轻微参与，形成“讲话时点头/前倾”的基础姿态。
- `body_yaw/body_roll` 可以轻微参与，避免身体完全静止。

不做：

- 音频 RMS 驱动。
- phoneme/viseme 级口型。
- 说话过程中的随机摆动。
- 插帧、曲线、逐帧参数变化。

### LipSyncPlanner

职责：

- 长期目标是把口型从静态 plan 中拆出来。
- 根据音频能量或音素，让 `mouth_open` 在说话过程中实时变化。

当前阶段暂不实现。

原因：

- 需要音频播放状态、音量包络或 phoneme 数据。
- 会涉及逐帧写参和参数优先级。
- 应晚于基础联动层实现。

### AmbientRuntime

职责：

- 处理无对话时的待机、呼吸、自动眨眼、随机 idle motion。
- 属于背景 runtime，不属于当前回复的 12 轴语义动作。

边界：

- 当前 turn 的动作 plan 不应该混入待机动画。
- 说话动作执行时，可以暂停或降低 ambient 写参权重。
- 待机恢复策略由 runtime 层处理，不由后端或 LLM 控制。

### CubismPhysics

职责：

- 使用 Live2D Cubism SDK 自带物理模拟。
- 处理参数写入后的物理响应。

原则：

- 不在 ModelEngine 重写 Cubism 物理。
- 如果需要额外“惯性/随动”，优先作为参数层联动或 runtime mixer，而不是替代 SDK 物理。

## 参数所有权

为了避免多个模块抢写同一参数，需要先建立参数所有权概念：

| 参数 | 主来源 | 次来源 |
|---|---|---|
| `head_yaw` | 语义动作 | `gaze_x` 联动、说话姿态 |
| `head_roll` | 语义动作 | 身体/情绪联动 |
| `head_pitch` | 语义动作 | `gaze_y`、`mouth_open`、说话姿态 |
| `body_yaw` | 联动/语义动作 | 说话姿态 |
| `body_roll` | 联动/语义动作 | 说话姿态 |
| `gaze_x` | 语义动作 | 眼神模块 |
| `gaze_y` | 语义动作 | 眼神模块 |
| `eye_open_left/right` | runtime blink/语义动作 | `mouth_smile`、`brow_bias` 联动 |
| `mouth_open` | lip sync | 语义动作、说话姿态 |
| `mouth_smile` | 语义动作 | 表情保持 |
| `brow_bias` | 语义动作 | 表情联动 |

特别说明：

- `mouth_open` 长期应该主要由口型驱动控制。
- `eye_open_left/right` 长期要和自动眨眼/表情联动协调。
- `body_yaw/body_roll` 是当前最需要补足的自然说话参数。

## 当前阶段实施边界

第一阶段只实现基础功能：

```text
motion_intent 12轴
-> CouplingEngine 基础联动
-> SpeechPoseEngine 基础说话姿态
-> 全局/单轴强度倍率
-> supplementary 生成
-> parameter_plan
```

第一阶段不实现：

- 待机模块重构。
- 呼吸系统重构。
- 实时口型驱动。
- 音频 RMS/phoneme 分析。
- 插帧、平滑、曲线。
- 多层 runtime mixer。

推荐执行顺序：

1. 新增 `coupling.ts`，实现 12 轴纯函数联动。
2. 新增 diagnostics：`couplingApplied`、`coupledAxes`、`speechPoseApplied`。
3. 在 `compiler.ts` 中接入联动，位置在强度倍率之前。
4. 设置层新增一个总开关和总强度：`couplingEnabled`、`couplingScale`。
5. Action Lab 显示 diagnostics，方便对比“原始 12 轴”和“联动后 12 轴”。

## 设计原则

- 联动只处理当前动作，不碰待机动画。
- 当前阶段只生成 plan，不做逐帧动态。
- 后端不参与联动演算。
- Runtime 不理解语义，只执行最终写参。
- 所有非显式补偿都必须可诊断，不能静默掩盖问题。
- 默认参数应保守，先保证不怪，再逐步增强表现力。
