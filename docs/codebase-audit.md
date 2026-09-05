# Executive Summary

复核日期：2026-09-04。对上一版报告提出的 6 个主要问题逐条回到源码、调用者、文档和 Git 历史复核。复核后已处理确认无生产调用者的静态 POST/API 扩展，以及配置 helper 的属性 fallback；其余结论维持只读审计。

| 指标 | 复核评分 |
|---|---:|
| 架构清晰度 | 8/10 |
| 概念一致性 | 8/10 |
| 职责单一性 | 8/10 |
| 修改可预测性 | 7/10 |
| 可删除性 | 7/10 |
| 可观测性 | 7/10 |

**AI 腐化风险：Low。** 上一版将若干有意设计误判为腐化：配置回读来自热刷新机制，前端多个 parser 分属不同不可信边界，`PlaybackTimeline` 的多层装配承担真实生命周期职责，`OLVPetPlatformAdapter` 是必要的 AstrBot composition root。复核后，确认的静态 POST/API 遗留扩展和配置属性 fallback 均已移除；其余问题降级为“设计复杂但有职责”或撤销。

# System Mental Model

```text
用户输入
  -> AstrBot Platform Adapter
  -> TurnCoordinator（协议路由、轮次身份、终态）
  -> OutputSegmentCoordinator（原子 output.segment.v4）
  -> WebSocket
  -> AdapterConnection 入站协议边界
  -> TurnPlaybackSessionStore（素材事实）
  -> PlaybackTimeline（音频时钟与 sink 生命周期）
  -> ModelEngine（语义动作/参数计划编译）
  -> Live2D WebSDK / LAppModel / Cubism Physics
```

复核确认的 ownership：

- 后端 `TurnCoordinator` 是入站交互与轮次终态的中枢；`OutputSegmentCoordinator` 负责输出段原子性。
- 前端 `SessionStore` 保存完整 segment 素材，`PlaybackTimelineRuntime` 持有播放生命周期；两者不是同一状态源。
- `model-engine/normalize.ts` 处理进入 ModelEngine 的 motion DTO；`inboundPayloads.ts` 处理 WebSocket 信封/slot；`planParser.ts` 处理参数计划；它们位于不同协议/信任边界。
- `createConversationPlaybackRuntime` 与 `playbackTimelineWiring` 是 app composition root 的装配层，延迟绑定由音频时长与模型同步时序要求导致。
- `OLVPetPlatformAdapter` 是 AstrBot Platform 的组装根，不是业务决策层；其代理方法大多保持外部框架接口。

# Top Problems

## Resolved — 静态资源服务器 POST/API 遗留扩展已删除

### Problem

`StaticResourceServer` 曾包含可注入 `api_handler`、POST `/api/*`、JSON 解析和通用 500 响应；当前生产装配没有传入 handler，仓库内也未找到前端、文档或部署脚本调用 `/api/`。已将其收敛为 GET/HEAD/OPTIONS 静态资源服务。

### Evidence

- `astrbot_plugin_ag99live_adapter/platform_adapter.py:132-140` 创建服务器时只传 `host`、`port`、`routes`。
- `rg` 全仓库结果显示 `api_handler`、`/api/` 只出现在该实现和本报告；生产唯一调用者是 `OLVPetPlatformAdapter._static_server`。
- Git：`15d8a13e`（2026-04-22）以“debug motion-plan ingress and analysis notebook prototype”引入；`f70357d`（2026-09-03）删除了独立 debug server，但未删除该服务器内部 API 扩展。该历史支持“遗留候选”，不能单独证明可删。
- 实施后：`static_resources.py` 不再导入 JSON/API handler 类型，也不声明 POST；`test_static_resources.py` 验证 CORS 仅声明 `GET, HEAD, OPTIONS`，且 POST 返回 HTTP 501。

### Why It Exists

历史调试/分析原型留下的通用接口；确认仓库内无生产调用者后已删除。

### Why It Is Dangerous

此前扩大本地 HTTP 端点和维护面；现已消除该扩展面。

### Recommended Direction

已删除 `api_handler`、`do_POST`、JSON API helpers，并保留静态文件服务测试。验证：静态音频 GET、OPTIONS CORS 声明、POST 拒绝、Python 编译通过。变更风险已关闭；实际已部署的仓库外客户端仍应在升级时观察。

## Resolved — `get_config_value` 配置协议已收紧为 Mapping

### Problem

配置 helper 曾在 Mapping `.get()` 不可用时回退属性读取，使配置对象协议不明确。当前 schema 是 JSON object，AstrBot 加载器传入的 `AstrBotConfig` 明确继承 `dict`。

### Evidence

- `astrbot_plugin_ag99live_adapter/_conf_schema.json` 全部配置为 object schema。
- 当前 AstrBot `star_manager.py` 以 `AstrBotConfig(...)` 构造并注入插件配置；`AstrBotConfig` 明确继承 `dict`。
- 全仓库调用点均对 Mapping 读取键值；`set_plugin_config()` 会立即复制为 canonical `dict`，磁盘热刷新也只返回 JSON object。
- 实施后 `get_config_value()` 仅接收 `Mapping[str, Any] | None`；聚焦测试覆盖配置值、缺失键和 `None` 默认值语义。

### Why It Exists

历史兼容性推测留下的通用读取分支。

### Why It Is Dangerous

属性对象会绕过已明确的配置边界，且使静态类型无法表达真实契约。

### Recommended Direction

已删除属性 fallback，保留 Mapping 的 `None`/缺失键默认值语义。变更不影响注入的 `AstrBotConfig` 或热刷新 JSON 快照。

# Reviewed And Downgraded Findings

## 配置三重读取面：撤销“架构问题”定性

上一版将 `get_plugin_config -> RuntimeState.refresh -> runtime fields` 视为三重来源。复核发现它们不是并列事实源：

- `set_plugin_config` 保存 AstrBot 注入对象和路径。
- `get_plugin_config` 优先读取该路径，用于得到最新磁盘快照；无路径时才回退到内存副本。
- `RuntimeState.refresh` 将最新快照投影为运行时字段，并在配置变化时重绑 provider。
- Git `576ae08`（2026-08-15）明确将 provider refresh 集中到 `RuntimeState.refresh`；`f70357d`（2026-09-03）刚完成配置分区收敛。

结论：这是热刷新 + 运行时投影的单一流程，不是已证实的多源冲突。仍可改进“配置来源诊断”，但不应建议删除磁盘回读。

## 前端多 parser：撤销“重复实现”定性

复核调用关系：

```text
WebSocket envelope
  -> inboundPayloads.parseOutputSegmentPayload（信封、tagged slots、exact keys）
  -> inboundOutputDispatcher
  -> normalizeMotionPayload（已解析 motion DTO -> ModelEngine 输入）
  -> ModelEngine compile
  -> planParser.parseSemanticParameterPlan（parameter_plan.v3 应用边界）
```

`usePreviewMotionPlayer` 和 `runtimeSnapshot.cloneMotionPlaybackRecord` 复用同一个 `planParser`；未发现第二个参数计划语义 parser。`modelSyncPayload.ts` 校验的是模型同步/Profile 传输结构，不是同一模型的重复 parser。结论：跨边界校验是合理的，风险仅是未来 schema 演化时需保持版本同步。

## 后端平台适配器过重：撤销 P2，保留可维护性观察项

`OLVPetPlatformAdapter` 必须实现 AstrBot `Platform` 接口并组装 `RuntimeState`、`MediaService`、`WebSocketTransport`、`TurnCoordinator` 等组件。`handle_msg`、`handle_binary_msg`、`emit_message_chain` 是外部框架入口的薄代理，不是重复业务实现。断开清理按 owner 逐项执行，属于生命周期边界。

结论：这是 composition root 的集中复杂度，不足以证明职责错误；未来新增能力时需避免继续把业务规则放入该类。

## 前端播放装配层级偏深：撤销 P2，保留真实时序复杂度

`createConversationPlaybackRuntime` 的延迟 `requireMotionRuntime()` 绑定，来自“Adapter/Timeline 先创建，ModelEngine 后准备”的时序；`PlaybackTimelineEngine`、`PlaybackTimelineRuntime`、`segmentJobExecutor` 分别管理状态机、运行时集合/清理和单段释放。源码和架构文档（`docs/01-架构与结构/01-项目总览与模块职责.md:165-176,619`）都明确了这些边界。

结论：调用链长，但不是无价值 wrapper 套 wrapper。只应在未来出现纯转发函数时局部删除。

## 防御链过度：降级为待验证观察项

宽泛 catch 和默认值数量多，但已找到明确边界理由：协议输入、可选 AstrBot hooks、连接断开 cleanup、可选 performance curve。当前证据不足以证明同一 invariant 在 3-5 层重复兜底；不能按数量定性为 AI 伪健壮性。

后续应按具体字段建立链路证据，再决定是否删除 fallback；本次不列为确定问题。

# Duplicate Concepts

| 概念 | 复核结论 |
|---|---|
| Turn / output segment | 后端 `TurnCoordinator` 与 `OutputSegmentCoordinator` 分工清晰；无第二队列证据 |
| Playback timeline / session | Timeline 持生命周期，SessionStore 持素材事实；不是重复 owner |
| Motion parser | 后端 provider 输入、前端 envelope、ModelEngine DTO、parameter plan 分属不同边界；未发现同语义 parser 的第二实现 |
| Profile validation | 后端持久化/生成与前端不可信同步校验职责不同 |
| 配置 | 热刷新与运行时投影职责分离；读取边界已统一为 Mapping |

# Suspicious Compatibility Code

## 需要人工确认

- `main.py:_optional_tts_state_hook` 与 `_optional_persona_expression_hook`：官方 AstrBot 兼容模式所需，不应删除，除非放弃官方兼容。
- `<@anim>` 兼容传输：README 与 `core_compatibility.py` 将其定义为外部能力兼容，不是动作失败 fallback。

# Excessive Defensive Programming

本次不认定存在已证实的“防御链重复”。可观察的合理边界包括：

- `inboundPayloads.ts`：不可信 WebSocket payload exact-key/tag 校验。
- `normalize.ts`：ModelEngine 入口的 motion DTO 规范化。
- `planParser.ts`：parameter_plan.v3 应用边界校验。
- `platform_adapter.py` / `turn_coordinator.py`：断开和终态 cleanup 的独立 owner 失败隔离。

建议未来针对具体字段记录“上游 invariant 建立点”，而不是按 `catch`/`??` 数量批量清理。

# Excessive Abstraction

复核未发现应整体删除的抽象链：

```text
usePetDesktopRuntime
  -> createConversationPlaybackRuntime
  -> createAppPlaybackTimelineRuntime
  -> createPlaybackTimelineRuntime
  -> executePlaybackTimelineSegmentJob
  -> motion sink / audio sink
```

每层都有可辨识职责：app composition、应用 wiring、Timeline runtime、单段执行。`OLVPetPlatformAdapter` 同样是框架 composition root。当前仅记录“修改入口需要跨层追踪”，不作为删除建议。

# Dead / Legacy Code Candidates

| 候选 | 证据 | 删除置信度 |
|---|---|---|
| 当前无已确认候选 | 静态 API 扩展和配置属性 fallback 均已处理 | — |

没有足够证据删除 `static_resources.py`、`PlaybackTimeline`、ModelEngine compiler、WebSDK、官方兼容 hooks 或任何 Turn/Session 状态类。

# Single Source of Truth Violations

- **已确认没有严重违反：** output segment、Timeline 生命周期、ModelEngine parameter plan、Live2D 逐帧写入均有单一主要 owner。
- **待改善：** 配置刷新来源诊断；跨端 schema 演化需要同步多个边界 parser，但这不是同一运行时事实源。
- **状态：** `SessionState`、`TurnIdentityMap`、前端 `TurnPlaybackSessionStore`、`PlaybackTimelineRuntime` 保存不同生命周期事实；当前文档和代码未显示重复终态 owner。

# Observability Gaps

- 已处理：`playbackTimelineWiring.ts` 对 `preparePlaybackTimeline()` 的 `not_applicable` 决策会通过既有 MotionLab 原始事件队列记录 `reason` 和 `timelineId`；不改变 Session 状态或把正常的“不需动作”解释为失败。
- 配置刷新日志能记录 provider/model 结果，但未统一显示“本次值来自注入对象还是磁盘快照”。这是改进项，不是配置错误证据。
- 后端多处异常日志已带 `turn_id` 或 `request_id`，但是否每条跨模块日志都有完整 `turn_id + message_id` 需要 live runtime 验证。

# Architectural Simplification Opportunities

1. 在配置刷新日志中明确 canonical 快照来源和 revision/mtime，减少诊断歧义。
2. 为跨端协议 schema 变更维护 parser ownership 表，避免未来出现重复语义校验。
3. 持续检查 MotionLab 中 `not_applicable` reason 与实际模型/音频配置是否一致。
4. 继续限制 `OLVPetPlatformAdapter` 只做框架入口与组装，不把新业务规则塞入其中。

# Potential Delete List

当前没有已确认且尚未处理的删除项。

# Refactoring Order

## Phase 1 — 配置消费者确认

已完成：AstrBot loader、插件入口、schema、热刷新路径和全量调用者均确认使用 Mapping。

## Phase 2 — 低风险遗留删除

已完成：删除确认无消费者的静态 API 扩展；保留静态 GET/HEAD/OPTIONS 和音频/模型资源路径。

## Phase 3 — 配置来源诊断

已完成：`get_plugin_config_snapshot()` 返回 canonical 配置、来源、文件路径和修改时间；`RuntimeState.refresh()` 的运行日志记录来源与 `mtime_ns`。注入快照、指定插件配置文件和默认插件配置文件现在可在运行日志中区分。

## Phase 4 — 观测补强

已完成 motion preparation `not_applicable` reason 记录；后续可补充配置来源和跨模块 correlation 的运行时记录。

## Phase 5 — 持续架构守门

新增功能时沿既有 `TurnCoordinator -> OutputSegment -> PlaybackTimeline -> ModelEngine -> WebSDK` 主链落位，避免新增平行队列、第二 parser、Manager/Facade 或兼容双路径。

# Reverse Self-Check

- 已回到源码、调用者、项目文档和 Git 历史复核上一版结论。
- 已撤销把合理协议边界、生命周期边界和 composition root 误报为 AI 腐化。
- 未因 `catch`、`??` 或 wrapper 数量直接推断缺陷。
- 未发现第二动作队列、第二参数写入器或同一业务决策在多个模块重复实现。
- 已处理确认的遗留项：静态 API 扩展和配置属性 fallback。
