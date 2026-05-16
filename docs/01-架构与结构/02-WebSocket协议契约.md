# AG99live 协议契约

本文档定义了当前 AG99live 的 WebSocket 协议。

它仅描述前端和后端之间当前活跃的外部协议。

## 信封结构

所有消息使用 V2 信封格式：

```json
{
  "type": "<消息类型>",
  "version": "v2",
  "message_id": "<非空字符串>",
  "session_id": "<字符串>",
  "turn_id": "<字符串 | null>",
  "orchestration_id": "<字符串 | null>",
  "source": "adapter" | "frontend" | "astrbot" | "engine",
  "timestamp": "<ISO 8601 时间戳>",
  "payload": { ... }
}
```

## 标识符契约

| 标识符 | 层级 | 所有者 | 作用 | 是否必须 |
| --- | --- | --- | --- | --- |
| `message_id` | 片段 | 协议 | 绑定一个助手回复片段 | 在携带片段的助手输出和 `engine.motion_intent` 中必须 |
| `turn_id` | 轮次生命周期 | 后端 | 连接 `turn_started` / `synth_finished` / `turn_finished` / `interrupt` | 在轮次范围内的消息中必须 |
| `orchestration_id` | 播放组 | 前端 | 前端首选的会话聚合键 | 可用时存在 |

前端会话解析顺序：

```text
orch:<orchestration_id>
turn:<turn_id>
```

`message_id` 作为片段键用于：

- `output.text`
- `output.audio`
- `engine.motion_intent`

它不作为以下消息的片段键：

- `output.image`
- `output.transcription`
- 大多数 `control.*`
- 大多数 `system.*`

## 完成信号

```text
control.synth_finished
= 后端输出队列关闭
= 此轮次不再有 output.* 或 engine.motion_intent 片段

control.playback_finished
= 前端本地播放已稳定
= 收到 synth_finished 且所有片段本地已稳定

control.turn_finished
= 后端轮次关闭
= 在后端收到 playback_finished 后发出
```

## 消息类型

### input.* （前端 -> 后端）

| 类型 | 载荷 |
| --- | --- |
| `input.text` | `{ text: string, images: ImagePayload[] }` |
| `input.raw_audio_data` | `{ audio: number[], sample_rate: number, channels: 1 }` |
| `input.mic_audio_end` | `{ reason: string, dropped?: boolean }` |

麦克风输入规则：

- 一段采集期使用一个新的 `input:*` `orchestration_id`。
- 该采集期的所有原始音频块和最后的 `input.mic_audio_end` 共享同一个 `orchestration_id`。
- 后端语音转文字入口使用该 `orchestration_id` 作为缓冲键。
- 如果 `dropped === true`，后端丢弃该片段且不进行转写。

### output.* （后端 -> 前端）

| 类型 | 载荷 | 需要 `message_id` |
| --- | --- | --- |
| `output.text` | `{ text: string, speaker_name: string, avatar: string }` | 是 |
| `output.audio` | `{ text: string, audio_url: string \| null, speaker_name: string, avatar: string }` | 是 |
| `output.image` | `{ images: string[] }` | 否 |
| `output.transcription` | `{ text: string }` | 否 |

### control.* （双向）

| 类型 | 方向 | 载荷 |
| --- | --- | --- |
| `control.turn_started` | 后端 -> 前端 | `{}` |
| `control.synth_finished` | 后端 -> 前端 | `{}` |
| `control.playback_finished` | 前端 -> 后端 | `{ success: boolean, reason?: string }` |
| `control.turn_finished` | 后端 -> 前端 | `{ success: boolean, reason?: string }` |
| `control.interrupt` | 双向 | `{}` |
| `control.start_mic` | 后端 -> 前端 | `{}` |
| `control.error` | 后端 -> 前端 | `{ message: string }` |

### system.* （双向）

| 类型 | 方向 | 作用 |
| --- | --- | --- |
| `system.server_info` | 后端 -> 前端 | 连接信息和运行时标志 |
| `system.model_sync` | 后端 -> 前端 | 模型能力同步 |
| `system.semantic_axis_profile_saved` | 后端 -> 前端 | 档案保存确认 |
| `system.semantic_axis_profile_save` | 前端 -> 后端 | 档案保存请求 |
| `system.semantic_axis_profile_save_failed` | 后端 -> 前端 | 档案保存失败 |
| `system.history_*` | 双向 | 历史记录增删改查 |
| `system.motion_tuning_sample_*` | 双向 | 动作调参样本增删改查 |

### engine.* （双向）

| 类型 | 方向 | 模式 |
| --- | --- | --- |
| `engine.motion_intent` | 双向 | `engine.motion_intent.v2` |

## 动作路径

当前外部动作协议路径：

```text
后端发出 engine.motion_intent
-> 前端归一化意图
-> 前端动作引擎在本地将意图编译为 engine.parameter_plan.v2
-> 前端运行时执行计划
```

后端主路径仅广播 `engine.motion_intent`。

如果显式调用后端运行时内部的回退机制，其结果仍必须返回到相同的 `engine.motion_intent` 路径和相同的片段标识。

## 模式版本

### 外部协议模式

| 模式 | 状态 | 作用 |
| --- | --- | --- |
| `engine.motion_intent.v2` | 活跃 | 后端到前端的语义动作载荷 |
| `ag99.semantic_axis_profile.v1` | 活跃 | 标准语义轴档案 |
| `live2d_runtime_cache.v1` | 活跃 | 后端 Live2D 扫描缓存 |

### 前端内部执行模式

| 模式 | 状态 | 作用 |
| --- | --- | --- |
| `engine.parameter_plan.v2` | 活跃 | 前端动作引擎编译后的执行计划 |

`engine.parameter_plan.v2` 是前端内部执行模式。它不是适配器预览的活跃入口类型。

## 实现文件

| 端 | 位置 |
| --- | --- |
| 后端常量 | `astrbot_plugin_ag99live_adapter/protocol/constants.py` |
| 后端解析器 | `astrbot_plugin_ag99live_adapter/protocol/parser.py` |
| 前端类型 | `frontend/src/types/protocol.ts` |
| 前端消息类型 | `frontend/src/adapter-connection/core/protocolMessageTypes.ts` |
| 前端入站映射 | `frontend/src/adapter-connection/inbound/inboundEvents.ts` |

## 变更规则

- 在前端和后端同时添加或删除协议消息类型。
- 在更新契约时同步更新模式校验。
- 除非适配器边界实际接受，否则不要将前端内部执行模式描述为外部协议消息类型。
