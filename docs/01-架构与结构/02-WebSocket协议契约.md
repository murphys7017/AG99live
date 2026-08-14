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
| `message_id` | 片段 | 协议 | 绑定一个原子助手回复片段 | `output.segment` 中必须；预览消息按自身契约使用 |
| `turn_id` | 轮次 | 前端创建，后后端回传 | 贯穿输入、输出、动作、打断、播放完成、轮次结束 | 所有交互链路消息必须；纯 `system.*` 可为 `null` |

约束：

- `turn_id` 是前后端唯一轮次主 ID。
- 当前外部协议信封不存在 `session_id`。
- 当前外部协议信封不存在 `orchestration_id`。
- 前端在文本发送前、麦克风开始采集前主动创建 `turn_id`。由后端发起的轮次不受此限制：AstrBot 主动输出由 Adapter 为每次 `send_by_session()` 创建独立的 `proactive:<uuid>` turn，并在 `output.segment` 前先发送 `control.turn_started`。
- 一次语音输入如果最终 dropped、空转写或失败，该 `turn_id` 立即终结且不可复用。

## 完成信号

```text
control.synth_finished
= 后端原子输出队列关闭
= 此轮次不应再追加新的 output.segment

control.playback_finished
= 前端本地播放已稳定
= 收到 synth_finished、该 turn 的槽位都已 settled，且没有开放的 required execution Timeline

control.turn_finished
= 后端轮次关闭
= 后端收到 playback_finished 后发出
```

`synth_finished` 是 turn 级输出队列关闭信号，不是单条音频生成完成信号。它到达前，每个已知 segment 必须已经由一个完整 `output.segment` 声明；到达后不接受新段，也不存在晚到 slot 补齐。

## 消息类型

### input.* （前端 -> 后端）

| 类型 | 载荷 |
| --- | --- |
| `input.text` | `{ text: string, images: ImagePayload[] }` |
| `input.audio_stream_start` | `{ stream_id: string, source: string, device_id?: string, encoding: "pcm16le", sample_rate: number, channels: 1 }` |
| WebSocket 二进制音频块 | `AG99` 二进制帧，见下文 |
| `input.audio_stream_end` | `{ stream_id: string, reason: string, dropped?: boolean, last_seq?: number }` |

`input.text` 通过协议校验后必须立即携带其前端 `turn_id` 提交 AstrBot EventBus。Adapter 不因较早 Turn 仍在前端播放而拒绝输入，也不维护第二套输入 FIFO；排队与串行处理由 AstrBot EventBus / Personal Runtime 负责。每个 `PlatformEvent` 保存自己的 `output_correlation_id`，后续物理输出聚合、`control.synth_finished`、`control.playback_finished` 和 `control.turn_finished` 都按该 ID 独立关联，禁止从最新的全局 Turn 推断旧事件身份。

麦克风输入规则：

- 一段采集期只使用一个新的采集根 `turn_id`。
- 该采集期先发送 `input.audio_stream_start`，随后发送一个或多个 WebSocket 二进制音频块，最后发送 `input.audio_stream_end`；三者共享同一个采集根 `turn_id` 与 `stream_id`。
- PTT 在 `input.audio_stream_end` 时把该段 PCM16LE 转成一个对话输入。常开收音持续传输同一采集会话的音频，后端使用 `stream_id` 作为缓冲键，并为每段 VAD 语音派生 `<capture_turn_id>:vad:<n>` 作为正式对话 turn ID。
- 对 VAD 子轮次发出的 `control.interrupt` 只能定位同一采集会话仍在飞的上一子轮次，不能使用采集根 ID；常开采集不会因完成一轮转写而停止。
- 如果 `dropped === true`，后端丢弃该 turn 的本次音频并立即终结该 turn。
- Electron / Windows 桌面端的设备枚举和采集可以来自主进程 DirectShow/ffmpeg，也可以回退到浏览器 `MediaDevices`。原生路径直接让 ffmpeg 输出 `s16le`，Web Audio 路径在 renderer 内把 Float32 转成 PCM16LE。
- 按键说话模式只改变采集开始/结束时机。按下配置按键等价于开始一段麦克风采集，松开按键等价于发送该段 `input.audio_stream_end(reason="ptt_release")`。
- 非流式 JSON 数组音频协议已删除；未知旧类型会作为不受支持的消息拒绝。

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
| `output.segment` | `output.segment.v3` 原子段，见下文 | 是 |
| `output.transcription` | `{ text: string }` | 否 |

`output.segment.v3` 的结构：

```json
{
  "schema_version": "output.segment.v3",
  "text": { "state": "present", "content": "唯一助手文本 / 语音字幕" },
  "audio": {
    "state": "present",
    "url": "/cache/audio/reply.wav"
  },
  "motion": {
    "state": "present",
    "message_type": "engine.motion_intent",
    "mode": "expressive",
    "source": "persona_effect",
    "payload": {
      "schema_version": "engine.motion_intent.v4",
      "performance_curve_hint": {}
    }
  },
  "images": [],
  "speaker_name": "Alice",
  "avatar": ""
}
```

`text`、`audio`、`motion` 都必须使用显式 tagged slot：`present | absent | failed`，不得省略。表演曲线只有一个执行来源：`motion.payload.performance_curve_hint`；顶层 `performance_curve` 和段发送后的独立曲线 patch 都属于非法协议。

motion slot 的语义必须保持严格区分：

- `absent`：本段协议明确没有语义动作。音频存在且模型支持 voice-following 时，前端可以运行
  内部 speech-only 表现，但不得改写该 slot。
- `failed`：本段本应产生语义动作，但 effect、调度、schema、资源或编译链失败。前端可以继续播放
  已经合法的音频和字幕，但不得用 speech-only 或默认姿态替代正式动作，最终
  `control.playback_finished.success` 必须为 `false`。
- `present`：携带唯一合法 motion payload，并由 ModelEngine 正式编译和执行。

Adapter 通过内部 `ag99live_motion_schedule` 判断该段是否预期动作。已安排动作但 payload
缺失时必须生成 `motion.state=failed`，不能因为最终没有 motion object 就写成 `absent`。

`output.segment.v1/v2` 不再兼容接收；前后端必须同时使用 v3，避免同时维护正文和音频字幕两份文本事实。

`output.segment.v3` 是封闭协议：根对象以及 `text`、`audio`、`motion` slot 只允许契约声明字段。`caption_text`、`performance_curve` 或其他未知字段必须在前端入站边界直接拒绝，不得静默丢弃。

AstrBot 内部 Plain、Record、图片与 motion client object 可以物理分离，但 Adapter 必须先按 `turn_id + message_id` 聚合，再发送一个 `output.segment`。TTS 物理分片通过组件 `delivery_metadata.output_segment.message_id` 归入各自逻辑段；其中 AstrBot TTS turn、逻辑 message、`tts_request_id` 与 AG99 前端 turn correlation 必须一致，不一致时拒绝整段。没有段级元数据的普通标准输出才使用 `standard_reply`。只有 `complete_visible_turn()` 可以关闭输出队列。Plain 文本、Persona semantic text 与 `Record.text` 都归一化到同一个 `text.content`；值不一致时整段报冲突。`audio` slot 只承载媒体 URL，不再拥有第二份 caption。

当 `audio.state = present` 时，`text.state` 也必须为 `present`。前端在真实 Audio `playing` 前只保留这份 canonical text，起播时才把它显示为字幕；audio 明确 `absent` 时才立即显示 text。audio 在起播前失败时字幕也显式失败，不伪装成正常 text-only 回复。

`control.synth_finished` 只能在至少一个 `output.segment` 成功发送后发送；其 WebSocket 发送成功后，后端才能提交 `output_queue_closed`。零段收口或发送失败必须显式报错。

`audio.url` 指向 Adapter HTTP 静态资源，常见路径为 `/cache/audio/*.wav`。前端可以按当前连接重写 host；如果 URL 无法 fetch，属于音频交付 / 静态资源服务问题，不等同于 TTS 生成失败。

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

`control.playback_finished` 只收口信封中的 `turn_id`，较早 Turn 的播放完成不得重置或清理较新的后端 Turn。`control.interrupt` 也只作用于信封中的 `turn_id`：Adapter 只停止该 Turn 对应的 AstrBot event，事件发送边界拒绝该 Turn 的晚到输出，随后前后端分别结束该 Turn 的播放与会话状态。它不是会话级 `stop_all`，也不需要 `message_id`。

WebSocket 连接直接断开时没有可发送的 `control.interrupt`。Adapter 必须先将所有在飞 event
标记为 `agent_stop_requested` 并调用 `stop_event()`，再清理连接级 Turn、pending segment、
performance curve 和 ID 映射。迟到的 AstrBot 输出在 `OLVPetPlatformEvent.send()` 边界被丢弃，
不能重新创建已断开的输出链路。

### system.* （双向）

| 类型 | 方向 | 作用 |
| --- | --- | --- |
| `system.server_info` | 后端 -> 前端 | 连接信息、运行时标志和完整 schema manifest |
| `system.model_sync` | 后端 -> 前端 | `live2d_scan.v3` 前端运行能力投影 |
| `system.semantic_axis_profile_saved` | 后端 -> 前端 | 档案保存确认 |
| `system.semantic_axis_profile_save` | 前端 -> 后端 | 档案保存请求 |
| `system.semantic_axis_profile_save_failed` | 后端 -> 前端 | 档案保存失败 |
| `system.history_*` | 双向 | 历史记录增删改查 |
| `system.motion_tuning_sample_*` | 双向 | 动作调参样本增删改查 |
| `system.motion_lab_raw_event` | 前端 -> 后端 | 提交带稳定 `event_id` 的原始动作事件 |
| `system.motion_lab_raw_event_recorded` | 后端 -> 前端 | SQLite 持久化完成确认，载荷为 `{ event_id: string }` |

纯 `system.*` 消息允许 `turn_id = null`。

连接必须首先通过 `system.server_info.schema_manifest` 握手。前端逐项比对 protocol version 和所有子 schema；任意一项缺失或不一致都拒绝后续消息，不兼容旧载荷。这通常表示 AstrBot 还在运行提交前的旧插件进程，需要重载插件或重启 AstrBot。

`astrbot_plugin_ag99live_adapter/protocol/schema_manifest.json` 是版本唯一事实源：Adapter 生产代码通过 `schema_versions.py` 读取，Electron 生产代码只使用 `protocolSchema.generated.ts` 的对应常量。协议变更必须原子更新 Adapter 与 Electron；`live2d_scan.v3` 升级还会使旧扫描缓存失效并触发重新扫描，禁止通过兼容分支继续消费旧缓存。

`system.model_sync` 不是后端扫描缓存的镜像。它只携带 renderer 加载模型、ModelEngine 编译、资源冲突检查和动作实验室展示所需字段。参数动作库以 `parameter_action_library.v2` 投影给前端；扫描器的其它中间结果仍属于 Adapter 内部，不跨 WebSocket 传输。

`runtime_cache_errors` 只存在于 `system.model_sync.payload` 根部，与 `model_info` 并列。它描述 Adapter 扫描缓存和样本缓存的运行诊断，不是 `live2d_scan.v3` 模型能力的一部分；前端分别写入 ModelSync state，禁止在 `model_info` 内复制第二份。

Motion Lab 事件采用 at-least-once 交付：前端必须先把事件写入 IndexedDB，再通过 WebSocket 发送；WebSocket `send()` 成功不代表记录成功。后端以 `event_id` 作为 SQLite 主键幂等写入，只有插入事务完成后才发送 `system.motion_lab_raw_event_recorded`。前端收到匹配回执后才能删除 IndexedDB 记录；断线重连时使用相同 `event_id` 重发。

## 传输部署边界

- 当前 WebSocket、静态资源 HTTP 和 debug HTTP 只支持绑定 `127.0.0.1` 或 `localhost`。
- 当前没有远程客户端认证、TLS、跨主机媒体授权或 IPv6 URL 规范化；`::1` 也不属于支持值。
- `audio.url`、Live2D 资源 URL 和连接地址都依赖同一回环部署假设。
- 远程 AstrBot 属于后续公开协议设计，不能通过把当前 `host` 改成局域网地址实现。

## 动作路径

当前正式动作路径：

```text
后端把 motion intent 放入 output.segment.motion.payload
-> 前端在原子段预校验阶段归一化意图
-> 前端动作引擎在本地将意图编译为 engine.parameter_plan.v3
-> 前端运行时执行计划
```

后端不再为正式回复独立广播 `engine.motion_intent` 或 `engine.performance_curve_hint`。手动预览是前端本地能力：保存的 `CompiledSemanticMotion` 直接进入第二阶段参数编译，不经过 WebSocket。

### `engine.motion_intent.v4`

`engine.motion_intent.v4` 是当前 Persona Effect 自动动作链路的主协议。

约束：

- `intent_tags` 是必需语义输入；`axis_levels`、`motion_steps` 和 `motion_resource_id` 是三选一的执行形态。
- `axis_levels` 唯一合法形态是 `Record<string, -4|-3|-2|-1|0|1|2|3|4>`；`motion_steps` 由 2–4 个同轴集合的等级步骤组成。
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

未使用的 resource 字段必须省略，不能发送空字符串。`expression_resource_id` 与
`motion_resource_id` 不能同时出现：

- expression 资源可与不冲突的参数计划叠加。
- motion 资源是完整动作主层，必须替代 `axis_levels` / `motion_steps` 和普通参数计划。
- motion resource 不允许同时携带 expression resource、`duration_hint_ms` 或 performance curve hint。
- 字段存在但资源不存在、类型不匹配、缺少参数所有权或运行时定位信息时，整个 motion segment 失败。
- v4 不接受旧的单一 `resource_id`；官方 `<@anim>` 兼容运输同样使用 typed resource 字段。

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
