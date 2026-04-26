# ModelEngine 主参数语义设计

快照日期：2026-04-26

> Superseded：本文是固定 12 轴阶段的语义分层设计记录，已被 `docs/主轴重构计划/` 中的动态主轴方案替代。后续实现以 `SemanticAxisProfile`、`motion_intent.v2`、`parameter_plan.v2` 为准；本文仅保留为历史背景和语义参考。

## 目的

本文件只讨论 `ModelEngine` 的“主参数语义”应该如何设计。

这里的核心问题不是“Live2D 有哪些参数”，而是：

- 哪些参数应该由大模型直接表达语义。
- 哪些参数应该由 `ModelEngine` 派生。
- 哪些参数应该交给运行时根据音频、眨眼、待机或物理系统驱动。
- 最终仍然如何兼容当前 `engine.motion_intent.v1` / `engine.parameter_plan.v1` 的 12 轴结构。

## 核心结论

当前 12 轴不应该被理解为“12 个同等重要、都由 LLM 主控的参数”。

更合理的理解是：

```text
LLM 主语义槽位
-> ModelEngine 派生/联动槽位
-> Runtime 驱动槽位
-> 最终输出兼容的 12 轴 parameter_plan
```

也就是说，最终 plan 仍然可以保留 12 轴，但内部控制权不同。

## 12 轴重新分级

### A. LLM 主语义轴

这些轴适合由大模型直接表达，因为它们更接近“人物此刻想表达的姿态和表情”。

| 参数 | 语义 | 说明 |
|---|---|---|
| `head_yaw` | 头部左右朝向 | 左右看、侧身关注、回避 |
| `head_roll` | 头部歪斜 | 疑惑、俏皮、柔和、困惑 |
| `head_pitch` | 头部俯仰 | 点头、低头、抬头、前倾 |
| `gaze_x` | 视线左右 | 看向一侧、躲闪、关注对象 |
| `gaze_y` | 视线上下 | 低垂、抬眼、观察 |
| `mouth_smile` | 嘴角/笑意 | 开心、温和、安抚、坏笑 |
| `eye_open_left` | 左眼表情开合 | 不是自然眨眼，而是眯眼、睁大、wink hint |
| `eye_open_right` | 右眼表情开合 | 不是自然眨眼，而是眯眼、睁大、wink hint |

注意：

- `eye_open_left/right` 的语义不是“普通眨眼”。
- 普通 blink 应该由 runtime 的生理动作系统负责。
- LLM 只表达表情性眼部状态，例如眯眼笑、惊讶睁眼、困倦半眯、单眼 wink。

### B. ModelEngine 派生/联动轴

这些轴不适合作为 LLM 强主控。它们更适合由 `ModelEngine` 根据主语义轴推导。

| 参数 | 推荐控制权 | 派生来源 |
|---|---|---|
| `body_yaw` | ModelEngine 主导 | `head_yaw`, 说话姿态, 情绪强度 |
| `body_roll` | ModelEngine 主导 | `head_roll`, `head_pitch`, 说话姿态 |
| `brow_bias` | ModelEngine 主导 | 眼部表情、`mouth_smile`, `emotion_label` |

原因：

- 身体朝向通常是头部动作的自然跟随，不应完全依赖 LLM 同时输出。
- 眉毛的模型差异较大，单独强控容易怪。
- `brow_bias` 更适合由眼部表情和嘴角表情联动派生。

### C. Runtime 驱动轴

这些轴应该主要由运行时驱动，而不是 LLM 静态输出。

| 参数 | 推荐控制权 | 来源 |
|---|---|---|
| `mouth_open` | Runtime 主导 | 语音播放、音频能量、口型系统 |

原因：

- 张嘴动作应跟音频播放、语速、停顿同步。
- LLM 给静态 `mouth_open` 容易造成“说话时嘴不动”或“不说话嘴还开着”。
- 短期可以把 LLM 的 `mouth_open` 当作 hint；长期应由 lip sync 覆盖。

## 当前协议兼容策略

短期不改协议。继续接收和输出 12 轴：

```text
head_yaw
head_roll
head_pitch
body_yaw
body_roll
gaze_x
gaze_y
eye_open_left
eye_open_right
mouth_open
mouth_smile
brow_bias
```

但解释方式调整：

| 参数 | 短期处理 |
|---|---|
| LLM 主语义轴 | 使用 LLM 输出作为主输入 |
| `body_yaw` | LLM 输出只作为 hint，默认由 `head_yaw` 派生 |
| `body_roll` | LLM 输出只作为 hint，默认由 `head_roll/head_pitch` 派生 |
| `brow_bias` | LLM 输出只作为 hint，默认由眼部/嘴角/情绪派生 |
| `mouth_open` | LLM 输出只作为 hint，语音播放时应由口型/音频驱动覆盖 |

这能避免一次性改协议导致前后端和调试工具全部重写。

## 语义槽位建议

长期更稳定的 LLM 输入不应该强调“12 个物理参数”，而应该强调“核心语义槽位”。

建议的主语义槽位：

| 语义槽位 | 对应当前轴 |
|---|---|
| 头部方向 | `head_yaw` |
| 头部歪斜 | `head_roll` |
| 头部俯仰 | `head_pitch` |
| 视线方向 | `gaze_x`, `gaze_y` |
| 眼部表情 | `eye_open_left`, `eye_open_right` |
| 嘴角情绪 | `mouth_smile` |

不建议让 LLM 主控的槽位：

| 槽位 | 理由 |
|---|---|
| 身体朝向 | 应从头部和说话姿态派生 |
| 眉毛偏置 | 模型差异大，应由眼部/情绪派生 |
| 张嘴幅度 | 应由音频/口型系统驱动 |
| 自然眨眼 | 应由 runtime 生理动作驱动 |

## 眼部语义设计

眼部参数应表达“表情性开合”，不是自然 blink。

建议定义：

```text
50 = 自然睁眼
< 50 = 眯眼、困倦、笑眼、wink
> 50 = 睁大、惊讶、警觉
```

左右眼差异：

- 两眼同时降低：笑眼、困倦、眯眼。
- 单眼明显降低：wink 或不对称表情。
- 两眼同时升高：惊讶、警觉、强调。

自然眨眼：

- 不由 LLM 输出。
- 不进入当前动作语义。
- 由 runtime blink/ambient 系统控制。

## 嘴部语义设计

嘴部分成两个职责：

| 参数 | 语义 |
|---|---|
| `mouth_smile` | 嘴角情绪，适合 LLM 主控 |
| `mouth_open` | 说话张合，适合 runtime/lip sync 主控 |

设计原则：

- `mouth_smile` 表达情绪。
- `mouth_open` 表达音频同步。
- 当前阶段如果没有实时口型，`mouth_open` 可先保持弱 hint。
- 后续接入 lip sync 后，语音播放期间 `mouth_open` 应覆盖 LLM 静态值。

## 身体语义设计

身体不应完全由 LLM 主控。

推荐策略：

```text
body_yaw = mix(llm_body_yaw_hint, derived_from_head_yaw, derived_weight)
body_roll = mix(llm_body_roll_hint, derived_from_head_roll_pitch, derived_weight)
```

初始建议：

```text
derived_body_yaw = 50 + (head_yaw - 50) * 0.35
body_yaw = llm_body_yaw * 0.25 + derived_body_yaw * 0.75

derived_body_roll = 50 + (head_roll - 50) * 0.30
body_roll = llm_body_roll * 0.35 + derived_body_roll * 0.65
```

原则：

- 头是语义主导，身体是自然跟随。
- 身体不要比头更夸张。
- 身体联动应有 deadzone，避免小幅眼神/头部变化导致身体抖动。

## 眉毛语义设计

`brow_bias` 不建议作为 LLM 主控轴。

推荐派生来源：

- `eye_open_left/right`
- `mouth_smile`
- `emotion_label`

示例：

| 情况 | 派生倾向 |
|---|---|
| 微笑明显 | 眉眼放松 |
| 眼睛睁大 | 眉毛惊讶/上扬 |
| 眼睛半眯且 smile 低 | 认真、怀疑或疲惫 |
| 情绪为 angry/serious | 眉毛紧张，但强度保守 |

注意：

- `brow_bias` 在不同模型上方向可能不一致。
- 第一阶段建议弱写或只诊断。
- 后续应依赖模型 calibration profile 修正方向和幅度。

## 第一阶段推荐主语义集合

如果后续要优化 prompt，可以优先让 LLM 稳定输出以下 8 个核心语义轴：

```text
head_yaw
head_roll
head_pitch
gaze_x
gaze_y
eye_open_left
eye_open_right
mouth_smile
```

其余 4 个轴：

```text
body_yaw
body_roll
mouth_open
brow_bias
```

作为兼容字段保留，但控制权降级为 hint/派生/runtime。

## 对后续模块的影响

### SemanticMotionCompiler

应继续接收 12 轴，但内部区分：

- `primarySemanticAxes`
- `derivedAxes`
- `runtimeDrivenAxes`

### CouplingEngine

第一阶段重点处理：

- `head_yaw -> body_yaw`
- `head_roll/head_pitch -> body_roll`
- `mouth_smile -> eye_open_left/right`
- `eye_open + emotion_label -> brow_bias`

### SpeechPoseEngine

第一阶段只做静态说话姿态，不碰待机：

- 轻微身体参与。
- 轻微头部参与。
- 不负责实时口型。

### LipSyncPlanner

后续接管 `mouth_open`：

- 根据音频播放状态和能量输出动态开口。
- 与 `mouth_smile` 叠加时需要 mixer 规则。

### AmbientRuntime

负责自然眨眼、呼吸和待机。

不要把自然 blink 写进 LLM 主语义轴。

## 当前阶段不做的事

- 不改协议结构。
- 不删除 12 轴字段。
- 不把待机动画合入说话 plan。
- 不实现实时口型。
- 不实现插帧/曲线。
- 不重写 Cubism 物理。

## 总结

`ModelEngine` 的主参数语义应从“12 个同级物理参数”升级为“分层语义控制系统”：

```text
LLM 主控：
  head_yaw/head_roll/head_pitch
  gaze_x/gaze_y
  eye_open_left/right as eye expression
  mouth_smile

ModelEngine 派生：
  body_yaw/body_roll
  brow_bias

Runtime 驱动：
  mouth_open
  natural blink
  breathing
  idle motion
```

最终仍输出兼容的 12 轴 plan，但每个轴的控制权必须清晰。
