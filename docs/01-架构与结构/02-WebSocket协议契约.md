# AG99live 协议契约

本文档定义当前 AG99live 的 WebSocket 外部协议。

它只描述前端和后端之间当前活跃的协议事实，不描述 AstrBot 内部消息身份。

## 信封结构

所有消息使用 V2 信封格式：

```json
{
  "type": "<消息类型>",
  "version": "v2",
  "message_id": "<非空字符串>",
  "turn_id": "<字符串 | null>",
  "source": "adapter" | "frontend" | "astrbot" | "engine",
  "timestamp": "<ISO 8601 时间戳>",
  "payload": { ... }
}
```

## 标识符契约

| 标识符 | 层级 | 所有者 | 作用 | 是否必须 |
| --- | --- | --- | --- | --- |
| `message_id` | 片段 | 协议 | 绑定一个助手回复片段 | `output.text`、`output.audio`、`engine.motion_intent` 中必须 |
| `turn_id` | 轮次 | 前端创建，后后端回传 | 贯穿输入、输出、动作、打断、播放完成、轮次结束 | 所有交互链路消息必须；纯 `system.*` 可为 `null` |

约束：

- `turn_id` 是前后端唯一轮次主 ID。
- 当前外部协议信封不存在 `session_id`。
- 当前外部协议信封不存在 `orchestration_id`。
- 前端在文本发送前、麦克风开始采集前主动创建 `turn_id`。
- 一次语音输入如果最终 dropped、空转写或失败，该 `turn_id` 立即终结且不可复用。

## 完成信号

```text
control.synth_finished
= 后端输出队列关闭
= 此轮次不再有新的 output.* 或 engine.motion_intent

control.playback_finished
= 前端本地播放已稳定
= 收到 synth_finished 且该 turn 的本地片段都已 settled

control.turn_finished
= 后端轮次关闭
= 后端收到 playback_finished 后发出
```

## 消息类型

### input.* （前端 -> 后端）

| 类型 | 载荷 |
| --- | --- |
| `input.text` | `{ text: string, images: ImagePayload[] }` |
| `input.raw_audio_data` | `{ audio: number[], sample_rate: number, channels: 1 }` |
| `input.mic_audio_end` | `{ reason: string, dropped?: boolean }` |

麦克风输入规则：

- 一段采集期只使用一个新的 `turn_id`。
- 该采集期的所有 `input.raw_audio_data` 和最后的 `input.mic_audio_end` 共享同一个 `turn_id`。
- 后端语音转文字入口使用该 `turn_id` 作为音频缓冲键。
- 如果 `dropped === true`，后端丢弃该 turn 的本次音频并立即终结该 turn。

### output.* （后端 -> 前端）

| 类型 | 载荷 | 需要 `message_id` |
| --- | --- | --- |
| `output.text` | `{ text: string, speaker_name: string, avatar: string }` | 是 |
| `output.audio` | `{ text: string, audio_url: string \| null, speaker_name: string, avatar: string }` | 是 |
| `output.image` | `{ images: string[] }` | 否 |
| `output.transcription` | `{ text: string }` | 否 |

同一回复片段的 `output.text`、`output.audio`、`engine.motion_intent` 必须共享同一个 `turn_id`，并各自带独立 `message_id`。

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

纯 `system.*` 消息允许 `turn_id = null`。

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

## 后端内部映射

外部协议只暴露 `turn_id`。

后端内部保留独立映射表：

```text
frontend_turn_id <-> astrbot_turn_id
```

AstrBot 内部 turn 身份不对前端暴露。

## 实现文件

| 端 | 位置 |
| --- | --- |
| 后端常量 | `astrbot_plugin_ag99live_adapter/protocol/constants.py` |
| 后端解析器 | `astrbot_plugin_ag99live_adapter/protocol/parser.py` |
| 后端 turn 映射 | `astrbot_plugin_ag99live_adapter/runtime/turn_identity_map.py` |
| 前端类型 | `frontend/src/types/protocol.ts` |
| 前端入站映射 | `frontend/src/adapter-connection/inbound/inboundEvents.ts` |

## 变更规则

- 在前端和后端同时添加或删除协议消息类型。
- 所有新的交互链路消息默认必须带 `turn_id`。
- 当前仓库只维护 `turn_id` 单轨协议，不提供 `session_id` 或 `orchestration_id` 兼容路径。
