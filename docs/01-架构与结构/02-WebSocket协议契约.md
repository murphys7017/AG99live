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
= 此轮次不应再追加新的 output.* 或 engine.motion_intent segment

control.playback_finished
= 前端本地播放已稳定
= 收到 synth_finished 且该 turn 的本地片段都已 settled

control.turn_finished
= 后端轮次关闭
= 后端收到 playback_finished 后发出
```

`synth_finished` 是 turn 级输出队列关闭信号，不是单条音频生成完成信号。为容忍传输顺序，同一 `turn_id / message_id` 的晚到媒体可以补齐已知 segment，但不得创建新 segment，也不得让已 release / started / terminal 的音频重复播放。

## 消息类型

### input.* （前端 -> 后端）

| 类型 | 载荷 |
| --- | --- |
| `input.text` | `{ text: string, images: ImagePayload[] }` |
| `input.audio_stream_start` | `{ stream_id: string, source: string, device_id?: string, encoding: "pcm16le", sample_rate: number, channels: 1 }` |
| WebSocket 二进制音频块 | `AG99` 二进制帧，见下文 |
| `input.audio_stream_end` | `{ stream_id: string, reason: string, dropped?: boolean, last_seq?: number }` |
| `input.raw_audio_data` | 兼容旧路径：`{ audio: number[], sample_rate: number, channels: 1 }` |
| `input.mic_audio_end` | 兼容旧路径：`{ reason: string, dropped?: boolean }` |

麦克风输入规则：

- 一段采集期只使用一个新的 `turn_id`。
- 该采集期先发送 `input.audio_stream_start`，随后发送一个或多个 WebSocket 二进制音频块，最后发送 `input.audio_stream_end`。
- `input.audio_stream_start`、二进制音频块元数据和 `input.audio_stream_end` 共享同一个 `turn_id` 与 `stream_id`。
- 后端语音转文字入口使用 `stream_id` 作为流缓冲键，并在 `input.audio_stream_end` 时把本段 PCM16LE 音频转成 STT 输入。
- 如果 `dropped === true`，后端丢弃该 turn 的本次音频并立即终结该 turn。
- Electron / Windows 桌面端的设备枚举和采集可以来自主进程 DirectShow/ffmpeg，也可以回退到浏览器 `MediaDevices`。原生路径直接让 ffmpeg 输出 `s16le`，Web Audio 路径在 renderer 内把 Float32 转成 PCM16LE。
- 按键说话模式只改变采集开始/结束时机。按下配置按键等价于开始一段麦克风采集，松开按键等价于发送该段 `input.audio_stream_end(reason="ptt_release")`。
- `input.raw_audio_data` / `input.mic_audio_end` 仍保留给旧前端或调试脚本，但不是当前 Electron 前端主路径。

二进制音频块格式：

```text
0..3    magic      ASCII "AG99"
4       version    1
5       frame_type 1 = microphone audio chunk
6..7    flags      little-endian uint16，当前保留为 0
8..11   meta_len   little-endian uint32
12..    meta       UTF-8 JSON
...     payload    PCM16LE bytes
```

元数据示例：

```json
{
  "stream_id": "mic:xxx",
  "turn_id": "input:xxx",
  "seq": 0,
  "encoding": "pcm16le",
  "sample_rate": 16000,
  "channels": 1
}
```

### output.* （后端 -> 前端）

| 类型 | 载荷 | 需要 `message_id` |
| --- | --- | --- |
| `output.text` | `{ text: string, speaker_name: string, avatar: string }` | 是 |
| `output.audio` | `{ caption_text: string, audio_url: string \| null, speaker_name: string, avatar: string }` | 是 |
| `output.image` | `{ images: string[] }` | 否 |
| `output.transcription` | `{ text: string }` | 否 |

同一回复片段的 `output.text`、`output.audio`、`engine.motion_intent` 必须共享同一个 `turn_id`，并各自带独立 `message_id`。

`output.audio.audio_url` 指向 Adapter HTTP 静态资源，常见路径为 `/cache/audio/*.wav`。前端可以按当前连接重写 host；如果 URL 无法 fetch，属于音频交付 / 静态资源服务问题，不等同于 TTS 生成失败。

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
| `system.motion_lab_raw_event` | 前端 -> 后端 | 提交带稳定 `event_id` 的原始动作事件 |
| `system.motion_lab_raw_event_recorded` | 后端 -> 前端 | SQLite 持久化完成确认，载荷为 `{ event_id: string }` |

纯 `system.*` 消息允许 `turn_id = null`。

Motion Lab 事件采用 at-least-once 交付：前端必须先把事件写入 IndexedDB，再通过 WebSocket 发送；WebSocket `send()` 成功不代表记录成功。后端以 `event_id` 作为 SQLite 主键幂等写入，只有插入事务完成后才发送 `system.motion_lab_raw_event_recorded`。前端收到匹配回执后才能删除 IndexedDB 记录；断线重连时使用相同 `event_id` 重发。

### engine.* （双向）

| 类型 | 方向 | 模式 |
| --- | --- | --- |
| `engine.motion_intent` | 双向 | 主协议：`engine.motion_intent.v4`；官方兼容：v3 |

## 动作路径

当前外部动作协议路径：

```text
后端发出 engine.motion_intent
-> 前端归一化意图
-> 前端动作引擎在本地将意图编译为 engine.parameter_plan.v2
-> 前端运行时执行计划
```

后端主路径仅广播 `engine.motion_intent`。

### `engine.motion_intent.v4`

`engine.motion_intent.v4` 是当前 Persona Effect 自动动作链路的主协议。

约束：

- `intent_tags` 和 `axis_levels` 是主语义输入。
- `axis_levels` 唯一合法形态是 `Record<string, -3|-2|-1|0|1|2|3>`。
- 省略轴表示本轮不控制，`0` 表示明确回到中性。
- v4 出现 `axes`、非法等级、未知轴或缺失 profile 锚点时直接失败，不降级为 v3。
- ModelEngine 使用 `SemanticAxisProfile.level_anchors` 转换等级，再进入关系图约束。
- 自动动作链路不允许输出 `choice`、`motion_id`、catalog motion、motion3、exp3 或旧播放文件引用。
- LLM 输出契约不包含 `mode`；Adapter 归一化后会补 `mode: "expressive"` 给现有 ModelEngine 编译链路使用。
- `idle` 是前端/运行时本底能力，不属于 LLM 本轮动作输出。
- `emotion_label`、`summary` 只属于系统派生字段，不是 LLM 输出目标。

示例：

```json
{
  "schema_version": "engine.motion_intent.v4",
  "profile_id": "pet.semantic.v1",
  "profile_revision": 2,
  "model_id": "pet",
  "mode": "expressive",
  "intent_tags": ["开心", "轻快", "看向用户"],
  "duration_hint_ms": 1000,
  "expression_resource_id": "expression.smile",
  "motion_resource_id": "",
  "axis_levels": {
    "head_yaw": 1,
    "head_pitch": 1,
    "body_roll": 1,
    "gaze_x": 1,
    "mouth_smile": 3
  },
  "emotion_label": "开心-轻快-看向用户"
}
```

`expression_resource_id` 与 `motion_resource_id` 都是可选字段，但不能同时为非空值：

- expression 资源可与不冲突的参数计划叠加。
- motion 资源是完整动作主层，播放时替代普通参数计划。
- 字段存在但资源不存在、类型不匹配、缺少参数所有权或运行时定位信息时，整个 motion segment 失败。
- v4 不接受旧的单一 `resource_id`；该字段只保留在官方 `<@anim>` v3 兼容协议中。

### `engine.motion_intent.v3`

v3 使用 flat number `axes`，只保留给官方 `<@anim>` 兼容入口和内部手动预览。它与 v4 进入同一个 ModelEngine，但不是 v4 校验失败后的 fallback。

`engine.motion_intent.v1/v2` 不再作为当前协议入口维护。

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
