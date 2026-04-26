# 03 Prompt 语义重写方案

## 目标

后端 prompt 不再硬编码固定 12 轴，而是根据 `semantic_axis_profile` 动态生成。

前提条件：

- 后端只能消费模型目录中的 canonical profile。
- 前端编辑后，必须显式保存回后端，后端再基于已保存版本生成 prompt。
- 后端不能在本地自行重新扫描并生成另一份 profile 来替代 canonical profile。

否则 prompt 和前端 ModelEngine 会使用不同的语义轴集合，导致同一轮里“模型输出可控轴”和“前端可编译轴”不一致。

核心目的是让模型明确：

- 它正在控制 Live2D 模型。
- 它输出的是当前回复/说话动作的语义姿态。
- 每个轴的 50、高值、低值、推荐范围、使用场景是什么。
- 哪些轴可以输出，哪些轴不应该输出。

## 平台描述必须写清楚

Prompt 必须包含平台语义：

```text
你正在为一个 Live2D 桌宠生成当前回复的动作语义参数。
这些参数不是自然语言描述，也不是完整动画脚本。
它们是 0..100 的 Live2D 表演控制值。
50 表示自然中心状态。
偏离 50 表示姿态或表情变化。
Live2D 表现可以比真人略夸张，但不应所有轴同时极端。
本次输出只描述当前回复动作，不包含待机动画、呼吸和自然眨眼。
```

## Prompt 只暴露 primary/hint 轴

从 profile 中筛选：

```text
control_role in [primary, hint]
```

不暴露：

```text
derived
runtime
ambient
debug
```

除非作为禁止说明。

例如：

```text
不要输出 mouth_open。它由语音口型系统控制。
不要输出 body_yaw。它由 ModelEngine 根据 head_yaw 派生。
不要输出自然眨眼。blink 由 runtime 控制。
```

## 单轴说明格式

每个可控轴都应使用统一模板：

```text
axis_id: head_yaw
中文名: 头部左右朝向
控制对象: Live2D 头部左右朝向
50: 正面自然朝向
高值: 向右看/右转头/调皮侧看
低值: 向左看/左转头/回避
日常推荐: 42..58
明显表现: 30..70
使用场景: 侧头回应、回避、看向对象、俏皮
避免: 普通回复不要长期极端，除非明确需要强动作
```

## 情绪指导

Prompt 应增加情绪到参数的建议，但不能写死为唯一规则。

示例：

| 情绪 | 建议 |
|---|---|
| happy | `mouth_smile` 提高，眼部表情略眯，头部轻微歪斜 |
| soothing | 幅度较小，头部轻微低垂或柔和侧倾，嘴角微笑 |
| surprised | 眼部睁大，头部轻微后仰或抬起，嘴角不一定笑 |
| confused | 头部歪斜，视线偏移，嘴角弱化 |
| shy | 视线避开，头部轻微下压，笑意弱到中等 |
| serious | 嘴角接近自然，眼部略收，头部更稳定 |

这些建议应来自 profile 的语义字段和项目内置情绪模板。

## 输出约束

motion_intent.v2 输出建议：

```json
{
  "schema_version": "engine.motion_intent.v2",
  "mode": "expressive",
  "emotion_label": "happy",
  "duration_hint_ms": 1200,
  "axes": {
    "head_yaw": { "value": 54 },
    "head_roll": { "value": 46 },
    "mouth_smile": { "value": 72 }
  },
  "summary": {
    "axis_count": 3
  }
}
```

规则：

- 只输出允许的 axis。
- 不要补 runtime/ambient/derived 轴。
- 不确定时使用接近 neutral 的值，而不是极端值。
- 至少输出与当前情绪相关的 2~4 个主轴。
- 强动作可以输出更多轴，但不应全部轴同时极端。

## 针对 runtime/derived 轴的说明

必须明确告诉模型不要控制这些轴：

```text
mouth_open:
  由音频口型系统控制。普通说话不要输出它。

body_yaw/body_roll:
  由 ModelEngine 根据头部和说话姿态派生。除非 profile 标记为 hint，否则不要输出。

brow_bias:
  由眼部表情、嘴角和 emotion_label 派生。不要单独大幅控制。

natural blink:
  不属于 intent。由 runtime 自动眨眼系统负责。
```

## Prompt 生成器输入

Prompt generator 需要：

- `semantic_axis_profile`
- `profile_id`
- `revision`
- 当前模型名称和平台说明
- 可选用户 prompt 指令
- 可选调参样本 few-shot
- 情绪模板

## Prompt 生成器输出

输出：

- 轴说明文本。
- JSON schema 约束。
- 禁用轴说明。
- 情绪建议。
- few-shot 样本。

## 第一阶段实现建议

第一阶段可以先不做复杂 prompt generator。

可先实现：

```text
profile -> primary axes markdown/text block
profile -> allowed axis ids list
profile -> forbidden axes note
```

然后替换现有固定 12 轴 prompt。

## 验收标准

- prompt 中不再出现硬编码 12 轴列表。
- prompt 明确说明 Live2D 平台和 0..100 语义。
- prompt 只要求输出 primary/hint axes。
- runtime/derived/ambient 轴被明确禁止或降级为 hint。
- 模型输出中如果出现 forbidden axis，解析层必须 warning 或 reject，不能静默接受。
