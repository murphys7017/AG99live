# Persona 动作意图样本归一化契约

状态：字段映射与首版采集边界。Adapter 已将 Persona 段语义和动作结果写入 Motion Lab raw-event store，事件类型为 `motion.persona_sample.v1`；相同 `sample_id` 下可有模型请求、Persona 段完成、流式预览和最终结果多个快照。M2 中模型请求与 Persona 段完成是不同时间点：请求快照保留模型实际看到的输入，完成快照保留最终 `speech/actions/tendency`。数据库查询界面、训练导出、人工评价和训练集筛选尚未实现。

范围只包含输入、Persona 段语义、动作生成结果和交付模式，不记录 Live2D 逐帧参数。VTube Studio 录制器仍是独立的参数观测工具。

## 记录对象

Core 的 canonical 输出以 `PersonaExpressionResult` 聚合表达通道与 effect 通道：

```json
{
  "turn_action": "reply",
  "segments": [
    {
      "speech": "啊……怎么会这样？",
      "speech_state": "ready",
      "actions": ["lower_head"],
      "tendency": {
        "Joy": 0,
        "Trust": 1,
        "Fear": 2,
        "Surprise": 8,
        "Sadness": 7,
        "Disgust": 0,
        "Anger": 1,
        "Anticipation": 0
      }
    }
  ],
  "effect_calls": []
}
```

`speech/actions/tendency` 属于 Persona 表达段；`effect_calls` 是独立的插件 Effect 通道。`actions` 是不带执行参数的自然动作意图，`tendency` 是角色当前的 Plutchik 八维情绪强度。两者语义不同，不能合并成一个标签。

AG99live 的动作生成结果是另一个对象：`engine.motion_intent.v4`。它包含 `intent_tags`，并选择 `axis_levels`、`motion_steps` 或 `motion_resource_id` 之一。当前 Adapter 规范化时从 `intent_tags` 派生 `emotion_label`；因此 `emotion_label` 是派生字段，不能当作独立于意图标签的原始监督标签。`tendency` 则是 Core 提供的八维状态，不能被 `emotion_label` 替代。

一条样本以一个逻辑 Persona 段为单位，并保留动作来源。推荐的归一化形状如下：

```json
{
  "sample_schema": "ag99live.persona_motion_sample.v1",
  "identity": {
    "turn_id": "...",
    "core_turn_id": "...",
    "persona_result_id": "...",
    "segment_index": 0,
    "segment_count": 2,
    "segment_message_id": "...",
    "sequence": 0
  },
  "delivery": {
    "mode": "M2_olv_incremental",
    "provider_previews": [],
    "motion_status": "open"
  },
  "input": {
    "user_text": "...",
    "recent_context": [],
    "motion_request_context": null
  },
  "persona_segment": {
    "speech": "...",
    "speech_state": "ready",
    "actions": ["..."],
    "tendency": {"Joy": 0, "Trust": 0, "Fear": 0, "Surprise": 0,
      "Sadness": 0, "Disgust": 0, "Anger": 0, "Anticipation": 0}
  },
  "motion": {
    "source_route": "independent_motion",
    "payload_kind": null,
    "raw_output": null,
    "accepted_payload": null,
    "provider_final": false,
    "emotion_label_derived": null
  },
  "eligibility": "unreviewed"
}
```

这是动作流仍打开时的记录层快照，不是新的 WebSocket payload，也不要求现在扩展 `output.segment.v6`。实际存储为追加式生命周期快照，不保证每行都是闭合样本；同一逻辑样本通过 `sample_id` 关联。Motion payload 要保留其实际执行形态；语义参数意图与已校验模型动作资源不可互相伪装，`payload_kind` 用于区分它们。

## 字段映射

| 归一化字段 | Core / 普通输出来源 | OLV 增量来源 | 记录规则 |
| --- | --- | --- | --- |
| `identity.turn_id` | 外层协议 envelope | 外层协议 envelope | 使用 AG99live Turn 身份。 |
| `identity.core_turn_id` | Adapter 内部 Core/Turn 绑定 | 每个增量事件公共身份 | 不得与外层 `turn_id` 混用。 |
| `identity.persona_result_id` | Persona result hook / Adapter 内部关联 | 每个增量事件公共身份 | v6 payload 本身不携带此字段。 |
| `identity.segment_index/count` | Persona `segments[]` 索引和总数 | 增量身份给出索引；总数可能未知 | 不用播放 `sequence` 替代 Persona 段索引。 |
| `identity.segment_message_id` | v6 envelope `message_id` | `segment_message_id` | 标识桌面侧逻辑播放段。 |
| `identity.sequence` | `output.segment.v6.payload.sequence` | 不适用 | 仅作普通输出段的 Turn 内播放顺序。 |
| `delivery.mode` | Adapter 生成路径的 M0/M1 来源 | OLV writer 的 M2 来源 | 必须在 Adapter 内部采集；不能从 v6 schema 推断 M0/M1。 |
| `input.user_text` | 当前输入事件的规范化文本 | 当前输入事件的规范化文本 | 只有实际提供给动作生成调用的数据才可填入。 |
| `input.recent_context` | 动作生成调用实际使用的上下文 | 动作生成调用实际使用的上下文 | 记录真实传入值；不可根据最终聊天历史反推。 |
| `input.motion_request_context` | 独立动作 Provider 的当前请求对象及可复现上下文 | 同左 | 可包含 `neurobrain_state`、最近执行动作等实际输入；Persona Effect 路径可为空。 |
| `input.capture_kind` / `provider_prompt_available` | Adapter 采集快照元数据 | 区分 Provider 请求快照和 Persona 段完成快照 | 完成快照标记 `persona_segment_completion_snapshot` 与 `false`，不能当作模型输入。 |
| `persona_segment.speech` | Core `segments[].speech`；对齐实际展示/TTS 的清洗后文本 | Core segment 输入及最终 text stream 内容 | 保留原始段语义与实际交付文本的对应关系；若清洗改变文本，两者不可静默混为一份。 |
| `persona_segment.speech_state` | Adapter 采集阶段 | Adapter 采集阶段 | `not_yet_ready` 表示动作请求先于完整段文本启动；`ready` 表示该快照中的 speech 已可用。 |
| `persona_segment.actions` | Core `segments[].actions` | Core `segment_start` 中的 actions | 按原值记录；不转换成 Live2D 参数。 |
| `persona_segment.tendency` | Core `segments[].tendency` | Core `segment_start` 中的 tendency | 保留八个键及 `0..10` 整数值；不要用 `emotion_label` 覆盖。 |
| `motion.source_route` | Persona Effect 或独立动作 Provider | 对应动作生产路径 | 必须区分来源，不能把两种监督行为混为一个来源。 |
| `motion.raw_output` | Effect call arguments 或 Provider 原始输出（若可取得） | 每次 motion update 对应的原始结果（若可取得） | 仅作来源审计；不要求当前桌面协议传输原始 Provider 文本。 |
| `motion.accepted_payload` | v6 `motion.present.payload`，或后到 `output.segment_motion` | Provider 候选或 `output.motion_stream_update.motion_payload` | 原样保留 Adapter 校验后的动作 payload；在 `motion_candidate` 中表示校验通过的候选，不代表已被 OLV writer 发送。`motion_result` 的 status 只表示 Provider 规范化结果。 |
| `motion.provider_final` | Provider 请求或结果快照 | Provider 请求、候选预览和最终结果 | 仅表示 Provider 本次生成是否结束，不代表 OLV motion stream 已发送或终止。 |
| `motion.provider_update_index` | 不适用 | 同一 Provider 请求内的闭合 JSON 候选序号 | Adapter 本地计数，不是协议 `seq`；候选可能在段启动前被后续候选覆盖。 |
| `motion.payload_kind` | 归一化动作类型 | 同左 | 区分语义参数意图与已校验模型动作资源；资源动作不强制补造 `intent_tags`。 |
| `motion.emotion_label_derived` | 语义参数意图可由 `intent_tags` 派生 | 同左 | 派生字段，非 Core 的 `tendency`；不支持该派生形态时留空。可在导出时再算。 |
| `eligibility` | 记录/审核阶段 | 记录/审核阶段 | 区分已观察、结构有效、人工审核和训练可用；不能把“已播放”自动当作高质量标签。 |

## 交付模式

| 模式 | 定义 | 当前交付 | 归一化要求 |
| --- | --- | --- | --- |
| `M0_nonstreaming` | 完整 Persona 结果后处理 | 完整 `output.segment.v6`；motion 可为 pending，之后由 `output.segment_motion` 补齐 | 以 `(turn_id, message_id)` 汇合 v6 与后到动作，保留 Persona 段身份的 Adapter 内部来源。 |
| `M1_persona_segment_stream` | Persona 段逐步形成，但每段仍走完整音频交付 | Persona segment hook + 完整输出段 | 虽然生成分段推进，桌面交付仍是 v6；记录时必须保留 M1 来源。 |
| `M2_olv_incremental` | 文本、PCM、动作各自增量交付 | `olv.incremental_output.v1` 的 text/audio/motion streams | 按 `(turn_id, core_turn_id, persona_result_id, segment_index, segment_message_id)` 关联样本；当前 Motion Lab 记录 Provider 候选和 Provider 终态，不采集各资源 wire `seq` 或 OLV motion 终态。 |

M0/M1 都使用 `output.segment.v6`，该 schema 没有 `delivery.mode`、`persona_result_id` 或 `persona_segment_index`。因此，只在桌面收到 v6 后记录，无法可靠地区分 M0/M1 或恢复完整 Persona 段身份。若要保留这些字段，记录点必须读取 Adapter 生成/绑定段时的内部事实，再与输出 envelope 身份关联；是否需要新增 wire 字段另行评估。

M2 的 text/audio/motion 是独立资源流。text delta 的到达顺序不能替代 Persona 段语义。独立动作请求会在 `persona_segment_intent_ready` 启动；此时 Provider 实际收到当前用户文本、历史上下文、`actions/tendency`，而 `segment.speech` 仍为空。该请求快照会记录完整实际 prompt，并将 `persona_segment.speech_state` 标为 `not_yet_ready`。稍后的 `persona_segment_ready` 快照记录完整段文本与意图，二者共用 `sample_id`，但完成快照不回填为模型输入。若某条路径在段文本就绪后才启动动作请求，则请求快照记录实际非空 speech。样本不应把最终全文伪装成动作生成时已知的前缀，也不应把每个 PCM 帧当作一条动作样本。

## 样本封闭与训练筛选

- v6 的 motion 为 `pending` 时，样本保持未封闭；收到 `output.segment_motion` 的 present/failed 终态后再封闭动作结果。
- M2 的 `provider_previews` 是模型候选，不等于已发送的 motion update；多个候选按 `provider_update_index` 保留，但段启动前的待发送槽可能只交付最后一个。`provider_final` 只表示 Provider 生成终态。当前 wire `seq`、revision、anchor 和 OLV 资源终态尚未写入 Motion Lab，导出时不得把候选直接当作已交付动作。
- 保存失败、拒绝、取消和无动作样本用于诊断；训练导出另行筛选，不将这些状态伪装成中性动作。
- M0/M1/M2 和 `persona_effect`/`independent_motion` 是不同维度：前者是交付模式，后者是动作来源。
- 保存原始 `tendency`、`actions` 和动作意图；`emotion_label` 可以复算，不应成为唯一情绪信号。
- 记录输入应遵循实际调用边界。无法取得的 Core Prompt、对话上下文或 Provider 原始输出标为缺失，不根据结果补猜。

## 当前代码事实与缺口

当前已能取得并写入样本事件的事实包括：

- Persona Effect 路径记录每段 `speech/actions/tendency`、匹配的 Effect arguments、规范化 payload、当前用户输入及 delivery mode。完整 Core Persona Prompt 不暴露给 Adapter，因此明确标注其输入上下文不完整。
- 独立动作 Provider 路径在调用前记录 `motion_request` 快照，因此 Provider 失败或取消时仍保留实际当前用户文本、历史上下文、segment 字段、NeuroBrain 状态、system/user prompt；结果快照再记录 raw Provider 输出和规范化 payload。M0/M1 会在 TTS/播放段绑定完成后追加 `segment_identity` 快照，补上真实 `segment_message_id`。M2 的 intent-ready 请求与 segment-ready Persona 快照分开记录。候选快照使用 `record_stage=motion_candidate` 和 `status=provider_preview`；请求、候选和最终结果的 `provider_final` 均表示 Provider 状态，不表示是否通过 OLV writer 实际发送。`motion_result.status` 使用 `provider_normalized` 或 `provider_failed`。
- v6 普通段的 text/audio/motion slots、message ID 和播放 sequence。
- M2 的 Core/Persona/segment/message 身份和 Provider 候选/结果；各资源 wire `seq` 与 OLV motion 终态当前未写入 Motion Lab。
- 独立 Provider 当前会收到当前用户文本、近期历史、当前段 speech/actions/tendency；条件满足时还会收到 NeuroBrain 状态和最近执行动作等参考。它们作为 `motion_request` 上下文记录，不误写成 Core Persona 字段。

当前样本仍不是可直接训练的数据集：M0/M1 v6 不携带 Persona 段身份，采集器依赖 Adapter 内部关联；M2 原始协议没有把 Core 的 `actions/tendency` 发给桌面，采集器在 Adapter 内部保留它们；Persona Effect 与独立 Provider 的输入范围不同，导出时应按 `source_route` 分组或显式投影，不要当成同分布样本。

Motion Lab raw-event store 升至 schema v3 时会清除旧 `motion_lab_raw_events` 表并重建；独立的 `motion_tuning_samples.json`、VTube Studio 录制库和 AstrBot 会话历史不受影响。桌面 IndexedDB Motion Lab v1 待发送队列在数据库升级时清空，避免旧格式离线事件在重连后重新写回。

## 依据

- AG99 Core：`docs/Yakumo/dev/output-contract.md` 与 `docs/Yakumo/dev/structured-persona-output/01-contract-and-schema.md`，描述 `PersonaExpressionResult`、`segments[].speech/actions/tendency` 和独立 `effect_calls`。
- AG99live：[动作语义与参数编译](../02-设计文档/04-动作语义与参数编译.md)、[动作生成与 Persona 分段关联](../01-架构与结构/07-动作生成与Persona分段关联.md)。
- AG99live：[OLV 全生命周期流式实施计划](../02-设计文档/12-OLV全生命周期流式实施计划.md)、[OLV 增量输出事件与生命周期契约](../02-设计文档/13-OLV增量输出事件与生命周期契约.md)。
- 代码权威：`astrbot_plugin_ag99live_adapter/protocol/schema_manifest.json`、`frontend/src/types/protocol.ts`、`astrbot_plugin_ag99live_adapter/main.py`、`astrbot_plugin_ag99live_adapter/middleware/interaction_motion/independent.py`、`frontend/src/adapter-connection/inbound/incrementalOutputProtocol.ts`。
