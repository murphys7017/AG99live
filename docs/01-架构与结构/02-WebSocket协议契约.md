# WebSocket 协议契约

## 当前版本

协议总版本为 **`v2`**。各 Schema 的唯一清单位于 `astrbot_plugin_ag99live_adapter/protocol/schema_manifest.json`，并生成到 `frontend/src/types/protocolSchema.generated.ts`。本页只解释这些 Schema 在链路中的职责，不复制一份可独立演变的版本表。

改动这些版本时，必须同时通过：

```powershell
python scripts/check_protocol_schema_manifest.py
```

## 传输原则

- WebSocket 在解析边界校验协议版本、消息类型、信封基本字段和消息专属必填字段。前端要求 `timestamp` 为非空字符串；后端归一化入站消息时会为缺失的 `timestamp` 补当前 UTC 时间。`turn_id` 是否允许为 `null` 由消息类型决定。
- 对启用精确键校验的 payload 和 slot，未知字段会被拒绝；不能将这一行为概括为所有后端 payload 的未知字段一律拒绝。
- 一个完整回复段通过 `type: output.segment` 的消息一次提交，Payload 的 `schema_version` 为 `output.segment.v5`。前端不会等待后续 patch，也不会依赖 `synth_finished` 才播放已完整到达的段。
- 文件、模型和缓存媒体通过 Adapter 的本机 HTTP 静态资源服务提供；前端只接受契约允许的绝对 URL。
- 麦克风 PCM16LE 使用二进制帧传输。历史的 JSON 数组音频路径已经删除。

## 消息类别

| 类别 | 方向 | 作用 |
| --- | --- | --- |
| `input.*` | 前端 -> Adapter | 文本、音频流、图片与用户交互控制。 |
| `output.*` | Adapter -> 前端 | 完整回复段、历史与可显示内容。 |
| `control.*` | 双向 | 连接、Turn 开始/结束、中断、模型同步与播放完成等生命周期信号。 |
| `system.*` | 双向 | 模型、profile、设置和动作实验室等系统资料。 |

## 桌面运行设置同步

桌面端在每次 WebSocket 连接建立时首先发送 `system.desktop_runtime_settings`，随后在设置变更时再次发送；`turn_id` 为 `null`，payload 必须包含布尔值 `persona_segment_stream_enabled`。Adapter 保存该连接的最新值，在构造 OLV 事件时决定是否请求 Persona 段流，并在断线时重置为关闭。设置写入后，同步消息先于桌面设置结果应答发送；普通文本及音频输入按同一 WebSocket 的顺序使用更新后的状态。

桌面端在本机持久化该选项，默认关闭。此同步不依赖 Web 控制页面是否打开，也不读取 Desktop Settings Broker 为页面展示缓存的最后已知值。Core 的 Persona 段流总开关、逐 speech 段独立动作及能力检查仍参与准入。部署时需配套更新桌面端和 Adapter。

## 原子输出段

`output.segment` 消息是回复播放的唯一入站业务单元，其 Payload Schema 为 `output.segment.v5`。它携带段归属和顺序，以及文本、音频状态、动作意图、speech cues 和需要的展示资料。Adapter 只在逻辑消息已满足可发送条件后提交该段；前端先严格解析全部 slot，再写入 SessionStore 并启动段任务。

协议的可选 `speech` slot 表示前端表演用的 speech cues；当前 Adapter 构造 `output.segment` 时将其设为 `absent`。AstrBot Persona 的 `segments[].speech` 是上游文本/TTS 分段输入，由 Adapter 在后端用于逐段动作绑定，不会因此变成协议 speech cues。两者名称相近但契约和生命周期不同。

不允许把文本、动作和音频拆成互相猜测归属的多个独立事件。重复、晚到或不符合当前生命周期的段会被拒绝或稳定地忽略，不能把 WebSocket 处理器带入致命状态。

没有进行 TTS 物料化的纯文本或状态段，Core→Adapter 的进程内 extras 不发送 `audio_attachment`，该字段须与完整的 TTS 身份元数据一起使用。Adapter 根据无音频物料生成协议的 `audio: { state: "absent" }`。状态段仍占用已校验的 Persona 索引，并以独立物理消息 ID 交付，不能跳号或复用父消息 ID。

## 音频输入

音频采集会话由 `input.audio_stream_start`、连续二进制 PCM16LE chunk 和 `input.audio_stream_end` 组成。它们共享 capture 身份；后端按 `stream_id` 汇总并校验顺序、模式和结束状态。`dropped: true` 表示前端因积压主动放弃该段，后端不会再转写它。

按键说话以 `reason="ptt_release"` 结束当前流。持续收音由 VAD 从采集根派生正式对话 Turn；身份规则见[协议身份与顺序](../02-设计文档/03-协议身份与顺序.md)。

### PTT 截图与转写并行

开启发送截图时，松手即采集本轮图片，同时先发送 `input.audio_stream_seal`，payload 为 `stream_id`、`last_seq`、`capture_mode="ptt"`。Adapter 校验与 start 相同的 `turn_id`、最后序号和模式后，封闭 PCM 并启动一次后台 ASR；seal 本身不创建正式对话。seal 后继续发送 PCM 或重复 seal 会被拒绝。

截图完成后，前端仍通过 `input.audio_stream_end` 提交 `images` 和 `desktop_snapshot_requested`。Adapter 复用本流转写结果，图片和文本完整后才提交一次用户输入，不重跑 ASR，不沿用旧图。未请求截图的 PTT 直接在 end 转写；manual/auto 的 VAD 切分保持原样。

截图调用最多等待 10 秒，失败或超时沿用原来的无图输入行为，晚到图片不再进入其他轮。seal 后若 15 秒仍未收到 end，Adapter 取消转写、清理采集准备并报告输入错误；等待 end 期间收到中断或进入断线清理也取消该 seal 任务。end 接管后的转写跟随处理协程取消，不新增通用 WebSocket 并发处理。每个连接最多保留 4 个等待 end 的 seal 输入。丢弃或校验失败的 end 不会提交已启动的转写。

此路径由 manifest 的 `audio_input` 项（`olv.audio_input.v1`）协商，必须配套加载桌面端和 Adapter 并重连。新增 `audio_seal_sent` 桌面时点，与后端 `latency.transcription_started/ready`、桌面 `screenshot_end/audio_end_sent` 对照验证重叠；单独通过源码或静态检查不能证明真实首播收益。

## 输入阶段预动作

`output.pre_action` 是独立的可选动作消息，不创建正式 Turn、播放段、语音或回执。manifest 增加 `pre_action: olv.pre_action.v1`，需双端配套加载。信封 `turn_id` 是本次输入 ID（或 VAD 子输入 ID），payload 固定包含：

- `schema_version: "olv.pre_action.v1"` 与唯一 `request_id`；
- `action: "ready"` 时，`motion` 为当前合法的 `engine.motion_intent.v4` 单姿态，`expires_at_epoch_ms` 为到期时刻；
- `action: "cancel"` 时，`motion` 与 `expires_at_epoch_ms` 均为 null。

桌面校验握手、当前连接最新输入/子输入、请求去重和到期时间，再交给 ModelEngine 的 `pre_action` 来源入口。结果只允许 1–2 个合法轴、绝对值不超过 2 的整数等级及短标签；资源和多步动作不在此路径。非法、取消或过期结果只影响预动作，不能终止核心对话。预动作不进入正式语音段的完成回执，正式动作开始后不得被迟到预动作抢占；同一输入被放弃/取消、历史切换、Profile 改变和断线都会清理该动作。

## 失败处理

协议层给出明确拒绝原因，不补字段、不重命名参数，也不生成默认动作。动作输入来自 Persona Effect 或独立动作 Provider，并统一校验为当前 V4 动作契约；协议不从对话文本标签解析动作。

`control.synth_finished` 关闭该 Turn 的输出队列，payload 必须包含布尔值 `success`，失败时必须带非空 `reason`。生成失败不会删除已经接受的原子段，也不会立刻把播放 Session 置为失败；这些段仍按原顺序播放。桌面在本地播放收口后发送 `control.playback_finished`，生成失败或本地播放失败时其 `success` 为 false。Adapter 保留生成失败原因，不能被客户端的成功回执覆盖，最终通过 `control.turn_finished` 返回失败。

本次契约要求配套更新 Adapter 与桌面客户端；旧的空 payload 不再是有效的 `synth_finished`。`output.segment.v5` 保持不变。

## 独立待机动作

`output.idle_motion` 是轮次之外的可选输出，信封 `turn_id` 必须为 `null`。
payload 仅包含 `motion`（已有 `engine.motion_intent.v4`）和
`expires_at_epoch_ms`（绝对过期时间，毫秒）。不创建 Session、播放队列或
合成/轮次结束信号；不发送播放确认。过期、重复、前台忙碌或 Profile 不匹配时直接丢弃。

桌面只把它编译为参数混合器的低优先级待机层，不调用正式动作替换入口。
权重缓慢进入、退出，当前对话、视线及口型优先。必须配套更新 Adapter 和桌面端。

## 代码位置

- Schema 清单：`astrbot_plugin_ag99live_adapter/protocol/schema_manifest.json`
- 后端解析与消息：`astrbot_plugin_ag99live_adapter/protocol/`
- 前端类型与解析：`frontend/src/types/`、`frontend/src/adapter-connection/`
- 协议检查：`scripts/check_protocol_schema_manifest.py`
