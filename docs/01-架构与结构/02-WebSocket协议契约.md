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

## 原子输出段

`output.segment` 消息是回复播放的唯一入站业务单元，其 Payload Schema 为 `output.segment.v5`。它携带段归属和顺序，以及文本、音频状态、动作意图、speech cues 和需要的展示资料。Adapter 只在逻辑消息已满足可发送条件后提交该段；前端先严格解析全部 slot，再写入 SessionStore 并启动段任务。

不允许把文本、动作和音频拆成互相猜测归属的多个独立事件。重复、晚到或不符合当前生命周期的段会被拒绝或稳定地忽略，不能把 WebSocket 处理器带入致命状态。

## 音频输入

音频采集会话由 `input.audio_stream_start`、连续二进制 PCM16LE chunk 和 `input.audio_stream_end` 组成。它们共享 capture 身份；后端按 `stream_id` 汇总并校验顺序、模式和结束状态。`dropped: true` 表示前端因积压主动放弃该段，后端不会再转写它。

按键说话以 `reason="ptt_release"` 结束当前流。持续收音由 VAD 从采集根派生正式对话 Turn；身份规则见[协议身份与顺序](../02-设计文档/03-协议身份与顺序.md)。

## 失败与兼容

协议层给出明确拒绝原因，不补字段、不重命名参数，也不生成默认动作。增强 Persona Effect 是主路径；官方 `<@anim>` 只在缺少 Persona 注入能力时运输兼容动作输入，内部仍使用当前 V4 动作契约。

## 代码位置

- Schema 清单：`astrbot_plugin_ag99live_adapter/protocol/schema_manifest.json`
- 后端解析与消息：`astrbot_plugin_ag99live_adapter/protocol/`
- 前端类型与解析：`frontend/src/types/`、`frontend/src/adapter-connection/`
- 协议检查：`scripts/check_protocol_schema_manifest.py`
