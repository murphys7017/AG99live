# AG99live 全仓架构审计

审计日期:2026-10-01 · 审计类型:减法式架构审计(只读)· 范围:全仓 552 个受版本控制的文件

本报告只报告事实与风险,不含任何已执行的修改。所有结论均给出 `文件:行号` 证据,并标注置信度。

---

## 1. Executive Summary

AG99live 是一个**边界划分清楚、Python 侧结构良好,但前端正在长出第二套运行时**的系统。

主干(AstrBot Adapter → WebSocket → Electron 渲染进程)分层是健康的:`TurnPlaybackSessionStore` 单点持有 turn 会话状态,`ModelEngine` 42 个文件 10,277 行承担动作编译,Adapter 侧协议经 `schema_manifest.json` 统一加载。这部分做得比多数项目好。

**主导的架构问题是 C++ 重写与 TS 运行时之间的协议版本同步缺少自动校验。** `runtime-core/` 在 `runtime-core/include/ag99/runtime/protocol.hpp:18-21` 手工维护 4 个协议版本字面量；`render-core/src/main.cpp:3149` 使用其中的 `kMotionIntentSchema`,而 `runtime-core` 不读取 `schema_manifest.json`。这意味着 manifest 与 C++ 常量可能各自演进,目前没有自动校验保证二者一致。同一套动作语义编译规则(`duration_weight` 1..3 约束、`motion_steps` 权重聚合)目前在 TS(`model-engine/normalize.ts:56-74`、`compileSemanticMotion.ts:71-124`)和 C++(`render-core/src/main.cpp:3145-3544`)中各自独立实现,且没有任何自动校验保证它们一致。

`render-core/README.md:74-78` 自己已经记录了这个矛盾:Adapter 只允许一个 WebSocket 客户端,前端与原生运行时连接同一 Adapter 会互相争抢会话。这个未决架构问题会随着迁移推进而放大。

其次是**终态词表分裂**:前端有三套 `isTerminalPhase` / `isTerminalSinkValue` 实现(见 Problem 3),其中一套含 `interrupted`、两套不含,同一个 turn 的终态在不同层得到不同判定。

### 评分

| 维度 | 分 | 说明 |
|---|---|---|
| 架构清晰度 | 7/10 | 主干分层明确,文档有真实的设计意图;原生迁移引入的第二平面没有与主平面建立边界契约。 |
| 概念一致性 | 5/10 | turn 身份有 5 个并行标识,终态词表三份,`normalizeTurnId` 六份实现。 |
| 单一职责归属 | 6/10 | Adapter 侧归属清晰;`useAdapterConnection.ts`(845 行/7 类职责)与两个巨型 SFC(逻辑占 70%+ 脚本)混杂。 |
| 变更可预测性 | 4/10 | 协议版本变更需同时改 Python manifest、TS 常量、C++ 头文件,前两者有脚本保护、第三者没有。 |
| 可删除性 | 5/10 | Spout / lip-sync / 快照链分层干净可拆;inbound 5 跳分发与 diagnostics 克隆是历史层叠。 |
| 可观测性 | 4/10 | ESP32 链路 7 条失败路径无任何日志;模型扫描失败导致前端收不到 `control.error` 而连接静默结束。 |

**AI 腐化风险:Medium。** 仓库的治理文档(`.ai/index.md`)明确写了 "Replacement Over Compatibility" 与 "do not add fallbacks, wrappers, or parallel paths",而代码现状是反模式最集中的一次:`runtime-core` + `render-core` 就是一次未完成的替换,并行路径已经存在。first-party 代码质量本身相当高(0 处 `as any`、0 处 `@ts-ignore`、0 处空 catch、0 处 TODO),腐化集中在"迁移未完成"这一结构性问题上,而非代码生成质量。

---

## 2. System Mental Model

三个进程,两个平面。

```text
[AstrBot 宿主]
   └─ astrbot_plugin_ag99live_adapter/   Python 插件
        ├─ protocol/    schema_manifest.json ← 协议版本唯一权威
        ├─ runtime/     turn 协调、段聚合、状态
        ├─ middleware/  interaction_motion (Persona 效果、prompt 注入)
        └─ transport/   WS :12396 / 静态资源 :12397
              │
              │ WebSocket v2 信封
              ▼
   ┌──────────[ 渲染平面 / 现行 ]──────────┐      ┌──[ 原生平面 / 重写中 ]──┐
   │ Electron 渲染进程                     │      │ render-core (C++20,     │
   │  inbound/ 5 跳分发                    │      │  D3D11 + Cubism Native) │
   │   ↓                                    │      │  runtime-core (协议/WS)  │
   │  turn-playback/ SessionStore(单 owner) │      │                        │
   │   ↓                                    │      │  CompileMotionPlan      │
   │  playback-timeline/ 时钟 + sink 协调    │      │  (内联于 main.cpp)      │
   │   ↓                                    │      └────────────────────────┘
   │  model-engine/ 语义→参数编译(42 文件)  │
   │   ↓                                    │
   │  live2d/ + WebSDK (WebGL) → Spout2     │
   └────────────────────────────────────────┘
```

**决策归属现状:**

| 决策 | 权威持有者 | 状态 |
|---|---|---|
| 协议版本号 | `protocol/schema_manifest.json` | 唯一权威,但不覆盖 C++ |
| turn 会话状态 | `useTurnPlaybackSessionStore` (前端) / `turn_coordinator` + `output_segment_coordinator` (后端) | 前端单 owner ✅;后端两份相关状态 ⚠️ |
| 动作语义编译 | `model-engine/compiler/` (TS) **和** `CompileMotionPlan` (C++) | **双 owner** ❌ |
| 播放时钟 | `playbackTimelineEngine` | 唯一 ✅ |
| 终态判定 | 三处独立实现 | **分裂** ❌ |
| 麦克风 / 窗口 / Spout | Electron 主进程 | 唯一 ✅ |

---

## 3. Top Problems

### P0-1 · 协议版本权威在原生迁移后失效

**Evidence**
- `astrbot_plugin_ag99live_adapter/protocol/schema_manifest.json` 是版本唯一权威,11 个 schema 版本 + `protocol_version`。
- `runtime-core/include/ag99/runtime/protocol.hpp:18-21`:
  ```cpp
  inline constexpr std::string_view kProtocolVersion = "v2";
  inline constexpr std::string_view kOutputSegmentSchema = "output.segment.v5";
  inline constexpr std::string_view kMotionIntentSchema = "engine.motion_intent.v4";
  inline constexpr std::string_view kModelInfoSchema = "live2d_scan.v4";
  ```
  manifest 中 11 个 schema,C++ 只认 4 个;其余 7 个(`ag99.semantic_axis_profile.v3`、`ag99.semantic_axis_relation_graph.v1`、`ag99.voice_following_profile.v3`、`ag99.performance_curve_hint.v1`、`engine.parameter_plan.v3` 等)在原生侧无任何定义。
- `render-core/src/main.cpp:3149` 使用 `runtime-core/include/ag99/runtime/protocol.hpp:20` 定义的 `kMotionIntentSchema`;该 C++ 常量不是从 manifest 生成的,`grep manifest runtime-core render-core` = 0 命中。
- `scripts/check_protocol_schema_manifest.py` 只做一件事:把 manifest 渲染成 TS 并与 `frontend/src/types/protocolSchema.generated.ts` 逐字节比对。**不读任何 `.py` 或 `.cpp` 文件。**

**Why It Exists**
迁移是分阶段进行的(`1c0b61e` → `979224a` 六个提交),每个阶段只搬一个能力,协议常量随代码一起被复制到 C++ 侧。

**Why It Is Dangerous**
改 `schema_manifest.json` 的版本号时,`check_protocol_schema_manifest.py` 只校验 TS 侧生成结果;若 C++ 常量未同步,原生 runtime 会在 `runtime-core/src/protocol.cpp:370` 抛 `ProtocolError("payload.schema_version must be output.segment.v5")`。仓库无 `.github/workflows`(glob 零匹配),该脚本仅在 `README.md:144` 作为手工步骤建议。

**Recommended Direction**
确立单一来源并让 C++ 参与校验。可行路径:生成 `protocol_versions.hpp` / `.h` 的构建步骤纳入 `runtime-core/CMakeLists.txt`,或让 C++ 读取一个由 manifest 生成的 JSON 头文件。方向是"让 C++ 从 manifest 派生",不是"在两处手工同步"。

**Change Risk**:中。生成代码需要确定加载路径策略(编译期生成 vs 运行时读取)。**Validation**:生成后断言 C++ 常量与 manifest 11 个 schema 全部一致;回放 CLI 用 v4/v5 两个版本样本各跑一次。

**Confidence**: confirmed

---

### P0-2 · 动作语义编译存在两个独立实现

**Evidence**
- TS 侧:`frontend/src/model-engine/` 42 文件 10,277 行。编译主链 `compileSemanticMotion.ts:39` → `compileModelParameterPlan.ts:29`,`motion_steps` 权重聚合在 `compileSemanticMotion.ts:71-124`,`duration_weight` 归一化在 `normalize.ts:56-74`。
- C++ 侧:`render-core/src/main.cpp:3145-3544`,`CompileMotionPlan` 约 400 行单体函数。同一套规则:`main.cpp:3391` 读 `motion_steps`、`:3401` 读 `duration_weight`、`:3407` 校验 `if (duration_weight < 1 || duration_weight > 3)`、`:3426` 算 blend-in。
- TS 侧的对应约束:`normalize.ts:74` `duration_weight: durationWeight as 1 | 2 | 3` —— **类型断言而非运行时校验**。C++ 侧是真校验。两侧对非法值的处理必然不同。
- `render-core` 与 `runtime-core` 之外,`git grep "ag99::runtime" -- frontend` = 0 命中:原生侧不引用任何前端代码,也不共享任何 TS 模块。

**Why It Exists**
性能重写。C++ 侧需要脱离 Electron/V8 独立运行,因此必须自带编译器。

**Why It Is Dangerous**
一个动作语义在两个运行时会编译出不同的参数计划。用户在 Electron 里调好 profile、看到预览正确,切到原生宿主后角色表现不同 —— 而两侧都"符合自己的实现",没有任何信号指出差异来源。`render-core/README.md:32-39` 列出的已实现能力(relation-graph propagation、blend-in/hold/blend-out、steps 权重聚合)与 TS 侧 `parameterTrackGraphCompiler.ts`(20,746 字节)+ `semanticAxisRelationGraphStage.ts`(15,078 字节)职责完全重叠,但两边的关系图传播算法没有对照测试。

**Recommended Direction**
明确谁是权威编译器。若原生运行时长期存在,编译器应只有一份权威实现(要么 C++ 为准并让 TS 退化为参考实现,要么反过来);另一侧应消费其输出而非重新实现。至少需要一组跨实现的黄金样本比对,让差异可被发现而不是靠用户肉眼发现。

**Change Risk**:高。编译器是表现力的核心。**Validation**:同一组 `engine.motion_intent.v4` 样本分别喂给两侧,断言参数计划逐字段一致;非法 `duration_weight` 输入的拒绝行为一致。

**Confidence**: confirmed(双实现存在)/ needs confirmation(迁移终态意图 —— 是"逐步替换"还是"长期双运行时")

---

### P1-3 · 终态词表三份实现,判定结果不一致

**Evidence**
- `turn-playback/session.ts:53` `isTerminalPhase` = `completed | failed`
- `playback-timeline/playbackTimelineEngine.ts:64` `isTerminalPhase` = `completed | failed | interrupted`
- `playback-timeline/playbackTimelineRuntime.ts:1349` `isTerminalSinkValue` 第三套
- 音频终态两套:`session.ts:76` `AudioTerminalState = idle | completed | failed | absent` vs `playback-timeline/contracts.ts:19-25` `SinkTerminal = idle | started | completed | failed | absent | interrupted`

同一个 `interrupted` 终态:`session.ts` 视角下不是终态,`playbackTimelineEngine` 视角下是终态。

**Why It Exists**
`interrupted` 是后加的终态,`session.ts` 的词表没有同步。`contracts.ts` 面向 sink 生命周期,`session.ts` 面向 turn 生命周期,两个词表从不同角度长出来。

**Why It Is Dangerous**
`turn_finished` 对未知 session 的处理路径(`inboundRuntimeDispatcher.ts:110-124`)依赖终态判定。判定分歧会让"已中断的 turn 被当作仍在播放"或反之,直接对应 `README.md:134` 尚未在真实桌面验证的"连续消息的顺序、取消和所有终态"。

**Recommended Direction**
一个终态枚举 + 一个 `isTerminal` 谓词,所有层共用。`SinkTerminal` 与 `AudioTerminalState` 的差异若确实有语义必要,需在类型层面表达(如区分 turn 级与 sink 级终态),而不是两份平级词表靠约定区分。

**Change Risk**:中。**Validation**:中断 / 完成 / 失败 / 缺席 四条终态路径的端到端播放验收,配合状态转换表的穷举测试。

**Confidence**: confirmed

---

### P1-4 · 一个播放段携带五个并行标识

**Evidence**
```
turnId          协议身份(inboundRuntimeDispatcher.ts:93 写入)
  └─ playbackTurnId   第二重 turn 身份(model-engine/runtime/motionRuntimeScheduler.ts:16,28)
  └─ sessionId        "turn:" + turnId (turn-playback/session.ts:235)
  └─ timelineId       "${turnId ?? 'preview'}:${messageId}" (playbackTimelineEngine.ts:47)
  └─ runId            (model-engine/runtime/contracts.ts:36)
```
`motionRuntimeScheduler.ts:240-241` 做 `normalizePlaybackTurnId ?? normalizeTurnId` 兜底;不一致时在 `:288` 记 `"playback_timeline_identity_mismatch"`,由 `modelEngineMotionSink.ts:48-53` 参与归属校验。

`turnId` 本身还有 3 个写入者:`inboundRuntimeDispatcher.ts:93`(turn_started)、`:165`(interrupt)、`outboundActions.ts:284`(`clearPlaybackGroupContext` 直接写 `ctx.state.currentTurnId = null`)。

**Why It Exists**
每个模块在自己的边界内需要一个本地标识(sink 按 timeline 归属、motion 按 playback 归属、session 按 turn 归属),逐步演化出多层。

**Why It Is Dangerous**
归属校验靠 ID 匹配字符串。任何一处生成规则变化都会静默落到 `identity_mismatch` 分支。`timelineId` 里 `"preview"` 这个回退值意味着预览播放与真实播放共用一个 ID 空间。

**Recommended Direction**
一个段身份对象,携带规范化后的 `turnId` / `messageId`,各层引用而非重新拼接。`playbackTurnId` 与 `turnId` 若本质相同应合并。

**Change Risk**:中。**Validation**:跨模块归属校验的负例测试(错误 turnId / messageId 必须被拒绝)。

**Confidence**: confirmed

---

### P1-5 · turn 终态在后端由两份状态表达,清理失败即永久分叉

**Evidence**
- `runtime/turn_coordinator.py:119-133` `_turn_terminal_results`(三态:缺失 / `None`=进行中 / `(bool, reason)`)
- `runtime/session_state.py:22-24` `current_turn_id`(`None`=idle)
- 二者交叉写入,`turn_coordinator.py:624-625`:
  ```python
  if self.session_state.current_turn_id == resolved_turn_id:
      self.session_state.reset_to_idle()
  ```
  条件不成立时 `current_turn_id` 保留旧值,与 `_turn_terminal_results` 已终结的事实不一致。
- `OutputSegmentCoordinator` 另持 `_closing_turn_ids` / `_closed_turn_ids` / `_emitted_turn_ids`(`output_segment_coordinator.py:67-74`),同时通过 `turn_coordinator.py:142` 的回调 `is_turn_terminal=lambda turn_id: turn_id in self._turn_terminal_results` 读另一份。
- `turn_coordinator.py:277-280` `reset_turn_tracking` 在清理不完整时 `raise RuntimeError("turn_tracking_cleanup_incomplete:...")` —— 一侧清理失败,两份状态永久分叉。

**Why It Exists**
turn 状态在 `turn_coordinator` 与 `output_segment_coordinator` 两个生命周期不同的对象里逐步各自累积。

**Why It Dangerous**
段缓冲已经 finalize 但段未发出 / 终态已记但 current_turn_id 未清 —— 这类不一致不会报错,只表现为"下一次对话的消息接不上"。

**Recommended Direction**
终态与队列关闭状态归一方持有,另一方通过查询接口读取,不各自维护集合。

**Change Risk**:高(涉及中断与清理路径)。**Validation**:`tests/unit/runtime/test_turn_coordinator_interrupt.py` 基础上增加"清理不完整"分支断言。

**Confidence**: confirmed

---

### P1-6 · 媒体文件缺失导致 turn 二次失败

**Evidence**
- `services/media_service.py:129-131` raise `FileNotFoundError`,`:142-148` 转码失败 raise `ValueError`
- `output_segment_coordinator.py:356-359` 通过 `asyncio.to_thread(self.media_service.cache_audio_file, ...)` 调用,**无 try**
- 异常冒泡到 `finalize_output_segment` → `platform_event.py:152` → `websocket_server.py:247-259` 变成泛化的 `control.error("Failed to process message.")`
- `output_segment_coordinator.py:226-230` 在 finalize 抛错时**不 pop** `_pending_segments`,该 turn 随后在 `close_turn_output_queue`(`:243-259`)以 `output_segment_not_finalized` 二次失败

**Why It Is Dangerous**
一个可恢复的单点失败(TTS 文件没落盘)被放大成 turn 级双重失败,并留下残留状态。前端收到的是完全无法定位的 `Failed to process message.`

**Recommended Direction**
音频获取失败应在段内降级(无音频段)或明确标记该段终态,并保证 `_pending_segments` 一定被清理。错误信息需携带失败的具体环节。

**Change Risk**:中。**Validation**:`tests/unit/runtime/test_media_service.py` + 一个"缓存文件缺失"的段 flush 用例。

**Confidence**: confirmed

---

### P1-7 · WebSocket 无鉴权,叠加 CORS `*` 构成本机攻击面

**Evidence**
- `transport/websocket_server.py:76-81`:
  ```python
  self._ws_server = await websockets.serve(
      self._handle_client, self.host, self.port, max_size=16 * 1024 * 1024,
  )
  ```
  无 `process_request`、无 token / Origin / subprotocol 校验。唯一约束是单客户端(`:207-217`),这是可用性约束而非身份约束。
- `transport/static_resources.py:42-44` 无条件 `Access-Control-Allow-Origin: *` + `Allow-Headers: *`
- 协议允许 `system.history_load`(读对话历史)与 `system.history_delete`(删对话)

**Why It Is Dangerous**
绑定 `127.0.0.1` 缩小了暴露面,但**任何本机进程或用户都能连接并发送合法协议消息**,包括读取和删除对话历史。叠加 CORS `*`,恶意网页可能跨域读取本机音频/图片缓存。是否被浏览器 Private Network Access 阻断 **needs confirmation**。

**Recommended Direction**
WS 握手时校验一个 Adapter 生成的会话 token(前端已有固定配置通道可传递);静态资源 CORS 收敛到具体 origin 或移除。

**Note**:路径穿越防护本身是**正确**的 —— `static_resources.py:19-33` 的 `_resolve_static_path` 用 `unquote` → `resolve()` → `relative_to(root)` 拦截,Windows 下 `..\` 与 `../` 混用同样被拦。这一点实现质量高于多数同类服务。

**Change Risk**:中(需协调前后端)。**Validation**:无 token 的 WS 连接被拒;带 `..` 的静态请求返回 404;非允许 origin 的跨域请求被拒。

**Confidence**: confirmed(无鉴权)/ needs confirmation(浏览器 PNA 是否实际阻断跨域读取)

---

### P1-8 · 视图组件内嵌业务逻辑,且校验规则只存在于视图

**Evidence**(script 段占真实比例,已逐文件核对边界)

| 文件 | 总行 | script | template | script 占比 |
|---|---|---|---|---|
| `components/MotionTuningPanel.vue` | 1375 | `1-975` | `977-1255` | **70.9%** |
| `components/SemanticAxisProfileEditor.vue` | 1024 | `1-768` | `770-992` | **75.0%** |
| `components/BaseActionPreviewPanel.vue` | 636 | `1-388` | `390-635` | **61.0%** |
| `components/AxisDetailForm.vue` | 619 | `1-125` | `127-618` | 20.2%(正常对照) |

- `SemanticAxisProfileEditor.vue:491-745`:`validateDraftProfile()` 约 157 行校验 + 8 个辅助函数 + `findRelationCycle()` DFS 环检测。全仓 grep **无对应 TS 模块** —— profile 校验规则只存在于视图内,无独立可测单元。
- `BaseActionPreviewPanel.vue:140-388`:`buildPlanStep` / `generatedPlan` / `buildAxisValuesFromAtoms` / `buildSemanticAxisValuesFromAtoms` —— **一个 plan 编译器被内联进了视图组件**。
- `SemanticAxisProfileEditor.vue:488` 手写 `JSON.parse(JSON.stringify(profile))` 深拷贝,绕过已有的 `src/utils/cloneJson.ts`(`projection.ts:1` 已在用)。

**Why It Is Dangerous**
profile 校验是与 model-engine 直接耦合的业务规则,放在视图里意味着无法被运行时复用、无法被 Adapter 侧复用、无法独立测试。而且 C++ 重写正在复制这套规则的语义 —— 视图里这份是第三份。

**Recommended Direction**
profile 校验与环检测移出视图,成为可被 model-engine 消费的单一实现;预览编译器同理。

**Change Risk**:低(纯搬迁)。**Validation**:搬迁前后同一组非法 profile 输入产生相同的错误集合。

**Confidence**: confirmed

---

### P2-9 · 快照契约一分为二,同一数组三重深拷贝

**Evidence**
- 类型与构建在 `desktop-bridge/projection.ts:75-216`(`buildDesktopRuntimeSnapshot`),而默认与归一在 `desktop-bridge/snapshot/runtimeSnapshot.ts:57/105/120` —— 同一份 `DesktopRuntimeSnapshot` 契约的"构建"和"默认/归一"分居两文件,且"projection"文件里放的是 snapshot 产物。
- 一次 publish 中 `microphoneDevices` 被复制 3 次:`usePetRuntimeSnapshotPublisher.ts:161` → `projection.ts:135` → `projection.ts:176`。`historyEntries` 同样 3 次。
- 为取最后一条 user 文本复制整个历史数组,`projection.ts:167-170`:
  ```ts
  const lastSent = p.historyEntries.slice().reverse().find((e) => e.role === "user")?.text ?? "";
  ```
- `useDesktopBridge.ts:474-475` 每次 publish 两次全量序列化:`persistRuntimeSnapshot` 内 `JSON.stringify` 写 localStorage,紧接着 `cloneJson` 再全量深拷贝用于广播。60ms 去抖(`usePetRuntimeSnapshotPublisher.ts:36`)会在每个 adapter 状态变化时重置。

**Why It Is Dangerous**
快照发布是前端最频繁的全量操作,重复的深拷贝与序列化是纯粹的浪费,也让"快照是投影还是快照"这个概念在代码里说不清。

**Recommended Direction**
快照构建单一归属;去抖改为最大间隔而非每次重置;`lastSent` 用反向遍历或维护游标。

**Change Risk**:低。**Validation**:快照内容在去抖调整后不变(现有 `test:desktop-bridge-clone` 可复用)。

**Confidence**: confirmed

---

### P2-10 · inbound 分发链 5 跳,其中两跳是同构映射表

**Evidence**
```
WebSocket.onmessage
→ adapterInboundRuntime.ts:67 handleSocketMessage
  ├─ :72  parseInboundEnvelope (inboundProtocol.ts:19)
  ├─ :90  mapInboundEnvelopeToEvent (inboundEvents.ts:178)
  ├─ :91  dispatchInboundEvent (本地,仅握手门禁)
  └─ :115 dispatchInboundEventToDeps (inboundDispatcher.ts:124)
      ├─ :130 inboundConnectionDispatcher.ts
      ├─ :144 inboundFeatureDispatcher.ts
      ├─ :149 inboundOutputDispatcher.ts  (唯一 async)
      └─ :157 inboundRuntimeDispatcher.ts
```
`inboundEvents.ts:182` 的 `switch (envelope.type)` 与 `inboundDispatcher.ts:128` 的 `switch (event.kind)` 是两张同构的 1:1 映射表。

**死依赖**:`InboundDispatchDeps.buildInboundEventContext` 声明于 `inboundDispatcher.ts:113`,4 个领域分发器**均未读取**;而 `mapInboundEnvelopeToEvent(envelope, _ctx)`(`inboundEvents.ts:180`)第二参带下划线、函数体内零引用,`adapterInboundRuntime.ts:94-98` 却每次折叠都真的构造它、`:159` 还塞进 deps。

**路由规则不同源**:`inboundDispatcher.ts:141-145` 的 `motion_lab_raw_event_recorded` 在顶层 switch 里**绕过** feature dispatcher 直接调 `acknowledgeMotionLabRawEventPersisted`。

**Recommended Direction**
合并两层同构 switch 为一张;删除 `buildInboundEventContext` 未使用参数及其构造;把 `motion_lab_raw_event_recorded` 归入 feature dispatcher。

**Change Risk**:低。**Validation**:`test:inbound-protocol` + `test:inbound-events` 覆盖消息类型映射,改造后应全绿。

**Confidence**: confirmed

---

### P2-11 · ESP32 链路失败完全静默,且开关不持久化

**Evidence**
- `esp32-display/useEsp32DisplayPipeline.ts` 7 条失败路径(`:296,302,316,327,344,355,365`)只写 `lastError.value = "composite_canvas_unavailable" | "webgl2_unavailable" | "toBlob_failed" | "send_rejected"` + `framesDropped`,**无 console**,不推 history。设置卡未打开时 ESP32 链路断开完全不可见。
- `enabled` 永不持久化:`useEsp32DisplaySettings.ts:30` 读取强制 `enabled: false`,`:46` 写盘强制 `enabled: false`;但 BroadcastChannel 路径 `applyConfig:54` 是 `target.enabled = source.enabled`(真同步),`:123` storage 事件路径又显式 `enabled: config.enabled`。两条同步通道对同一字段的处理互相矛盾。
- 设置单例无 teardown:`useEsp32DisplaySettings.ts:81` 模块级 `singleton`,`:85-87` BroadcastChannel、`:116-131` `storage` 监听永久注册无 dispose。
- `useEsp32DisplayConnection.ts:53-63,110-119` IPC 失败只 `console.warn`,且 `lastError` 由两个独立实例持有(`Esp32DisplaySettingsCard.vue:15` 与 `Esp32DisplayPipelineHost.vue:7` 各建一份),错误状态不同源。

**Recommended Direction**
失败路径接入统一日志/历史;`enabled` 的持久化语义定为单一决定;错误状态收敛到单 owner。

**Change Risk**:低。**Validation**:断开 ESP32 链路时设置卡与主窗口显示一致错误。

**Confidence**: confirmed

---

### P2-12 · 关键失败对前端静默,丢失可定位性

**Evidence**
- 模型扫描失败:`live2d/scanner/scan.py:229-235` 对**非选中**模型只 `logger.warning` + `continue`;选中模型才 raise(`:230-233`)。异常经 `websocket_server.py:71-73` 在 `_handle_client` 内抛出,最终被 `websocket_server.py:269-273` 捕获仅打日志并结束连接 —— **前端收不到任何 `control.error`**,用户体验是"连接上了但没有角色"。
- `core_compatibility.py:96-108` 在 `astrbot.core.prompt` 缺失时返回硬编码默认 key `"prompt_input_item_annotations"` / `"input.text"`,**不产生任何日志**。若上游常量改名而模块仍可导入,`platform_event.py:174,205` 会把注解写进错误的 extra key,prompt 注解静默丢失。
- `main.py:53-56` 反向布尔:
  ```python
  self._official_core_compatibility = not register_ag99live_interaction_contributors(context)
  ```
  `True` 表示"增强路径**不可用**"。`turn_coordinator.py:566-574` 进一步用 `getattr(runtime_state, "ag99live_motion_persona_effect_available", True) is False` —— 若 `runtime_state` 被替换或裁剪,默认 `True` 会让 `<@anim>` 兼容路径**静默关闭**。
- `adapter-connection/outbound/outboundClient.ts:35-49`:`send` 任何异常只 `console.warn` 并 `return false`;上游 `useAdapterConnection.ts:765-805` 的 history / motion-tuning CRUD 全部返回裸 `false`,调用方无法区分"socket 未开"与"序列化抛错"。

**Recommended Direction**
Adapter 侧所有影响用户可见状态的失败都发 `control.error`;兼容层降级必须记日志;布尔命名改为正向。

**Change Risk**:低。**Validation**:扫描失败时前端收到 `control.error` 并显示原因。

**Confidence**: confirmed

---

### P2-13 · 协议校验覆盖存在真空

**Evidence**
- `scripts/check_protocol_schema_manifest.py` 只覆盖 manifest ↔ TS,不覆盖 Python 侧任何文件,也不覆盖 C++(见 P0-1)。
- `parser.py:154-342` 的 `_validate_payload` 对 4 类入站类型**无对应分支**:`INBOUND_ALLOWED_TYPES`(`constants.py:99-113`)含 `TYPE_SYSTEM_BACKGROUND_LIST_REQUEST`、`TYPE_SYSTEM_HISTORY_LIST_REQUEST`、`TYPE_SYSTEM_HISTORY_CREATE`、`TYPE_SYSTEM_HEARTBEAT`,校验函数对它们静默通过。`parser.py:6` 的 docstring 声称"按 message_type 校验 payload 形状",与实现不符。
- `services/frontend_system_service.py:39-50` `SUPPORTED_SYSTEM_MESSAGE_TYPES` 是 `constants.py:99-113` `INBOUND_ALLOWED_TYPES` 的第二份白名单子集(10 个 system 类型),两份可各自漂移。
- `output_segment_coordinator.py:474-475` 在段 flush 时对**已校验**的 payload 再跑一次规范化,该行位于 `_flush_segment`(`:362`)内、`build_output_segment`(`:376`)之前 —— 若抛错会把已 finalize 的段打成发送失败。
- `live2d/scanner/scan.py:164` `CALIBRATION_PROFILE_SCHEMA_VERSION = "direct_parameter_calibration.v1"` 是一个**不在 manifest 中**的 schema 版本字面量,无生成、无校验、无前端同步。
- `motion/payload_validation.py:76-77,133-134` 异常文本未截断:
  ```python
  except Exception as exc:  # noqa: BLE001
      return None, f"semantic_profile_unresolved:{exc}"
  ```
  `_sanitize_reason_fragment`(`:270-272`,截断 80 字符)只作用于 resource id 片段,这条路径绕过它,最终经 `output_segment_coordinator.py:469` 进入 `output.segment` 的 `motion.reason` 字段发给前端,可能携带内部路径/堆栈摘要。

**Recommended Direction**
校验脚本扩展到 C++ 生成的常量文件;`_validate_payload` 补全 4 类分支或明确拒绝;两份 system 白名单合并;`payload_validation` 的异常文本统一走截断。

**Change Risk**:低~中。**Validation**:每类入站消息各一个接受/拒绝用例;异常文本长度上限断言。

**Confidence**: confirmed

---

### P3-14 · 文档与仓库结构漂移

**Evidence**
- `docs/01-架构与结构/01-项目总览与模块职责.md:33-43` 的仓库结构图只列 `astrbot_plugin_ag99live_adapter/`、`frontend/`、`vts-data-recorder/`、`scripts/`、`docs/` —— **不含 `runtime-core/` 和 `render-core/`**。而这两个目录已存在 6 个提交。
- `README.md:130` 声明"截至 2026 年 9 月 29 日,源码已包含完整的 Adapter...和 Spout2 输出链路",`README.md:86` 称"`runtime-core/` 是独立的原生运行时,不属于本次桌面安装包" —— 文档试图提及但架构文档未更新。
- `astrbot_plugin_ag99live_adapter/_conf_schema.json:44` 承诺"失败或**超时**不影响原动作播放",但全仓 grep `wait_for|asyncio.timeout` 仅命中 `runtime/motion_lab/recorder.py`,performance curve 路径**无任何超时实现**。
- `README.md:16` 称"默认服务仅绑定 127.0.0.1",但 `platform_adapter.py:52` `LOOPBACK_BIND_HOST` 是常量,`:92 self.host = LOOPBACK_BIND_HOST` 写死并**忽略 platform_config 的 host** —— 实际是"只能绑定回环",不是"默认绑定回环"。
- `platform_adapter.py:59,93` 与 `:60,94` 各有两份端口字面量。

**Recommended Direction**
架构文档结构图补入原生平面并说明其边界;删除或实现 `_conf_schema.json:44` 的超时承诺;README 措辞与实现对齐。

**Change Risk**:低(纯文档)。**Validation**:文档结构图与实际顶层目录一致。

**Confidence**: confirmed

---

### P3-15 · 构建产物与 vendored SDK 混入源码树

**Evidence**
- `runtime-core/build/` 与 `render-core/build/` 存在且被 `.gitignore` 覆盖(`runtime-core/build/`、`render-core/build/`),`git ls-files` 确认**未入库** —— 这是干净的。但工作区里 `render-core/build/_deps/nlohmann_json-src/` 完整第三方源码(约 20MB)常驻,且 `runtime-core/build/` 同样在本地存在。
- `frontend/src/live2d/WebSDK/` 内含 Cubism Framework/Core 完整第三方源码与 4 份 LICENSE/README,**与 first-party 代码同处 `src/`**。该目录内 44 处 `// eslint-disable-next-line @typescript-eslint/no-namespace`、`lappmodel.ts:1270` 注释 `// Cast to any to bypass potential type errors`。
- first-party 代码实测:0 处 `as any`、0 处 `@ts-ignore`、0 处空 catch、0 处 TODO/FIXME。**质量本身很好**,风险仅在于缺少隔离边界 —— 第三方与自有代码共享 `tsconfig` 与类型命名空间。
- 根目录 `package.json` 与 `frontend/package.json` 内容重复(同名 `ag99live-frontend`、同版本、同 4 个 dependencies),根目录那份无 `scripts`。疑似 `frontend/` 提升前的残留。

**Recommended Direction**
`WebSDK` 移到 `src/` 之外或至少排除出 first-party lint/typecheck 范围;根 `package.json` 若无用途则移除。

**Change Risk**:低。**Validation**:typecheck 与构建在移动后仍通过。

**Confidence**: confirmed

---

## 4. Duplicate Concepts

| 概念 | 位置 | 重叠 | 建议权威 |
|---|---|---|---|
| 动作语义编译 | `model-engine/compiler/`(10,277 行)vs `render-core/src/main.cpp:3145-3544` | 完全重叠,无共享 | 需先定迁移终态 |
| 协议版本 | `schema_manifest.json` / `protocolSchema.generated.ts` / `protocol.hpp:18-21` | 3 处,仅前两者有校验 | `schema_manifest.json` |
| `normalizeTurnId` | `inboundEvents.ts:59`、`core/turnIds.ts:1`、`playbackTimelineRuntime.ts:1345`、`modelEngineMotionSink.ts:43`、`model-engine/normalize.ts:107`、`motionRuntimeScheduler.ts` 内部 | 6 份,语义等价(trim → null/"") | `core/turnIds.ts` |
| 终态判定 | `session.ts:53` / `playbackTimelineEngine.ts:64` / `playbackTimelineRuntime.ts:1349` | 3 套,`interrupted` 归属不一致 | 单一枚举 + 单谓词 |
| 播放时钟读取器 | `model-engine/contracts.ts:4-6` 具名类型 vs `types/live2d-runtime.d.ts:44`、`types/direct-parameter-plan.ts:15`、`WebSDK/…/lappadapter.ts:17`、`lappmodel.ts:77`、`parametermixer.ts:56` 内联重写 | 5 处匿名重声明 | 具名类型 |
| 编译诊断类型 | `types/desktop.ts:161-228`(68 行)vs `types/compiledSemanticMotion.ts:48-80` | ~30 字段逐字重复,**已产生漂移** | 源类型 |
| system 消息白名单 | `constants.py:99-113` vs `frontend_system_service.py:39-50` | 第二份白名单子集 | `constants.py` |
| 深拷贝 | `utils/cloneJson.ts` vs `SemanticAxisProfileEditor.vue:488` | 手写 JSON 深拷贝绕过 | `utils/cloneJson.ts` |
| 快照构建 | `projection.ts:163-216` vs `snapshot/runtimeSnapshot.ts:57-120` | 类型/构建与默认/归一分居两文件 | 单一归属 |

**已证伪的"重复"假设**(避免无谓清理):Spout 每帧 buffer 复用正确(`useSpoutFramePublisher.ts:94-98` 仅尺寸变化时重建);`useLive2dRenderer` 与 `usePreviewMotionPlayer` 互补而非双驱动;三个 lip-sync 文件是三层链(`audioLipSyncCoordinator` → `lipSyncSink` 装饰 → `live2d/lipSyncTimelineSink` 叶子实现)不是三份实现;`outboundQueue` 已接线;`window-manager.ts` 无业务态(968 行全是窗口操作)。

---

## 5. Suspicious Compatibility Code

**确认必要的兼容**
- `core_compatibility.py` —— 探测 AstrBot Core 的两套增强 API(交互契约 + prompt 注解契约),有实际调用者:`runtime/state.py:14,87-89`、`middleware/__init__.py:3,7`、`platform_event.py:11,172`。**但**其静默降级路径(`:96-108`)不记日志,且 `turn_coordinator.py:566-574` 的 `getattr(..., True)` 默认值会让兼容路径在异常情况下静默关闭(见 P2-12)。
- 官方 AstrBot 走 `<@anim>` 的兼容入口 —— `README.md:74` 明确说明"该入口不承担增强 Persona Effect 的失败降级",是有意识的边界声明。

**很可能可移除 / 收敛**
- `InboundDispatchDeps.buildInboundEventContext`(`inboundDispatcher.ts:113`)—— 4 个消费者全部不读,但每条消息都真的构造(`adapterInboundRuntime.ts:94-98`)。**删除置信度:High**(4 个分发器逐一确认未读取)。
- `useDesktopWindowActions.ts`(15 行)—— 纯透传壳,唯一消费者 `DesktopWindowPanel.vue`。**删除置信度:High**。
- `outboundClient.ts` 的裸 `false` 返回链(`useAdapterConnection.ts:765-805`)—— 返回值语义不可区分,可收敛为抛错或具名结果。**删除置信度:Medium**(需确认是否有调用方依赖 `false` 而不检查)。

**需要确认**
- `core_compatibility` 兜底当前是否还会命中 —— 仓库未 vendored AstrBot(`astrbot.api` / `astrbot.core.*` 全为外部依赖),无法从本仓判定目标 Core 版本。**Needs confirmation:在目标环境打印 `astrbot.core.interaction` / `astrbot.core.prompt` 的实际导出符号。**
- `render-core/README.md:74-78` 描述的"前端与原生运行时通过本地 IPC 桥接"的最终形态尚未实现;当前是**两个独立 Adapter 客户端争抢同一会话**。**Needs confirmation:迁移终态。**

---

## 6. Excessive Defensive Programming

**已确认的防御链(合理)**
- `inboundDispatcher.ts:103-114` 的握手门禁 —— 边界防御,合理。
- `live2d-scan` 边界:非选中模型扫描失败 `logger.warning` + `continue` —— 合理(选中模型才 raise,`:230-233`)。
- `parse_inbound_message` → `_validate_payload` 的协议形状校验 —— 边界防御,单一实现,合理。

**用默认值掩盖失败的点**
- `outboundClient.ts:35-49`:任何发送异常 → `console.warn` + `return false`。上游 CRUD 无法区分失败原因。
- `useEsp32DisplayPipeline.ts` 7 条失败路径:只更新 `lastError` 与计数器,无日志、无 history 推送(见 P2-11)。
- `useAdapterMotionTuning.ts:177-230` 的 `motion_steps` / `duration_weight` 均以 `unknown` 接收再逐字段转换 —— `duration_weight: durationWeight as 1 | 2 | 3`(`model-engine/normalize.ts:74`)是**类型断言而非运行时校验**,而 C++ 侧是真校验(`main.cpp:3407`)。同一个非法值在两侧行为必然不同。

**正面发现**
- 全仓 0 处裸 `except:`,0 处 `except Exception: pass`。165 处 catch 全部带日志,且多数把错误收集进 `errors[]` 后**重抛**(`useAdapterConnection.ts:664-666`、`conversationPlaybackAudioRuntime.ts:176,204`)。这一点显著高于同类项目。
- 协议字段**不变量应在何处建立**:`duration_weight ∈ 1..3` 的权威校验点应在协议边界(Python `motion_intent.py` / 生成的 C++ 常量),而不是让 TS 断言、C++ 校验、Adapter 默认值各管一半。

---

## 7. Excessive Abstraction

**正常分层,不必动**
- `playback-timeline/` 的 sink 链(clock → runner → sink → release sinks)。
- lip-sync 三层链(见 §4 证伪说明)。
- `desktop-bridge/snapshot/` 4 个文件的边界清晰(已逐一确认:`runtimeSnapshot` 全量、`modelProjectionSnapshot` 模型投影、`profileAuthoringSnapshot` 草稿、`motionTuningSnapshot` 仅采样因不落盘故无 default/normalize 对)。

**多余层**
- inbound 5 跳分发,含 2 张同构 switch 表 + 1 个死参数(见 P2-10)。
- `useAdapterConnection.ts`:845 行、30 个模块级函数、1 个 39 字段 reactive state(`adapterConnectionState.ts:33-72`),同时承担 7 类职责 —— 传输生命周期(`:345 initialize` / `:372 connect` / `:453 disconnect` / `:498 dispose`)、地址持久化(`:330-341`)、麦克风透传(`:110-114`)、业务域 CRUD(`:84-100`)、播放桥接端口(`:123-139`)、UI 投影与历史(`:182-198` + `:685-708` 自持 120 条 LRU)、协议装配(`:174-180` + `:745+`)。**不是"不够抽象",而是"抽象层次错了"** —— 它同时是 transport、是 service、是 port、是 store。
- `useDesktopWindowActions.ts`:15 行透传壳,多一层无价值(见 §5)。

**注**:本项目的主要风险不是"抽象太少",而是"**同一抽象层次上有两个实现**"(P0-2)与"**业务逻辑落在错误的层次**"(P1-8)。

---

## 8. Dead / Legacy Code Candidates

| 候选 | 证据 | 删除置信度 | 需要什么才能提升 |
|---|---|---|---|
| `InboundDispatchDeps.buildInboundEventContext` | 4 个分发器均未读;`inboundEvents.ts:180` 第二参零引用 | **High** | — |
| `useDesktopWindowActions.ts` | 15 行纯透传,唯一消费者 `DesktopWindowPanel.vue:2,9` | **High** | — |
| 根 `package.json` | 与 `frontend/package.json` 同名同版本同 deps,无 `scripts` | **Medium** | 确认无工具链依赖仓库根 |
| `bilibili-live/` 的文档缺口 | 已接线(`usePetDesktopRuntime.ts:507-513`),但**无任何文档提及** | 不删除 | 补文档 |
| `runtime-core/build/`、`render-core/build/` | 本地存在,已 gitignore,未入库 | 不删除 | 保持忽略 |
| `main.py:53` `_official_core_compatibility` | 非死代码,但反向布尔致 3 处下游误读 | 不删除 | 重命名 |

**不构成死代码的(已逐一确认有调用者)**:`bilibili-live/`(`usePetDesktopRuntime.ts:47,507-513`)、`esp32-display/`(`App.vue:10,23` + 完整 IPC 链)、`motion-lab/outboundQueue.ts`(`usePetDesktopRuntime.ts:101,116,395-406`)、`action-lab/parameterExcludeKeywords.ts`(`BaseActionPreviewPanel.vue:96`、`SemanticAxisProfileEditor.vue:81`)、`runtime-core/tests/protocol_smoke.cpp`、Adapter 全部 21 个测试文件。

---

## 9. Single Source of Truth Violations

| 类别 | 违规 | 位置 |
|---|---|---|
| **协议版本** | manifest、生成的 TS 常量与手工维护的 C++ 常量未由同一检查覆盖 | `schema_manifest.json` / `protocolSchema.generated.ts` / `runtime-core/include/ag99/runtime/protocol.hpp:18-21` |
| **业务规则(编译)** | 2 套独立实现 | TS `model-engine/` vs C++ `CompileMotionPlan` |
| **业务规则(校验)** | profile 校验只存在于视图 | `SemanticAxisProfileEditor.vue:491-745`,无 TS 模块 |
| **终态判定** | 3 套实现,词表不一致 | `session.ts:53` / `playbackTimelineEngine.ts:64` / `playbackTimelineRuntime.ts:1349` |
| **段身份** | 1 个段 5 个标识 | turnId / playbackTurnId / sessionId / timelineId / runId |
| **状态** | turn 终态两份 | `turn_coordinator.py:_turn_terminal_results` vs `session_state.py:current_turn_id` |
| **状态** | ESP32 `enabled` 三条规则 | 读取强制 false / 写盘强制 false / BroadcastChannel 真同步 |
| **状态** | ESP32 错误两份 | `Esp32DisplaySettingsCard.vue:15` 与 `Esp32DisplayPipelineHost.vue:7` 各建一份连接实例 |
| **配置** | 端口双份字面量 | `platform_adapter.py:59,93` 与 `:60,94` |
| **配置** | 文档承诺不存在的超时 | `_conf_schema.json:44` vs 实现无超时 |
| **schema 版本** | manifest 外的游离版本 | `scan.py:164` `"direct_parameter_calibration.v1"` |
| **白名单** | 2 份 system 消息白名单 | `constants.py:99-113` / `frontend_system_service.py:39-50` |
| **类型** | diagnostics 手工克隆且已漂移 | `types/desktop.ts:161-228` 丢 `speechActive`/`relationAdjustments` 类型化形式,`transformTrace` 内联重写,`relationAdjustments: unknown[]` |

---

## 10. Observability Gaps

**无法重建的运行时路径**
1. **ESP32 链路全部失败** —— `useEsp32DisplayPipeline.ts` 7 条失败路径无 console、不推 history。设置卡未打开时,链路断开、帧丢弃、合成失败完全不可见。**这是最严重的一处。**
2. **模型扫描失败导致的前端状态** —— Adapter 侧只记日志并结束连接,前端无 `control.error`。用户看到"连接成功但没有角色",无法区分是模型路径错、SDK 缺失还是 profile 解析失败。
3. **prompt 注解降级** —— `core_compatibility.py:96-108` 静默返回默认 key,注解可能写进错误的 extra key 而无人知晓。
4. **段身份不匹配** —— `motionRuntimeScheduler.ts:288` 记 `"playback_timeline_identity_mismatch"`,但未说明是哪两个 ID 不一致、属于哪个 turn。
5. **`control.error` 泛化** —— 媒体获取失败最终变成 `Failed to process message.`(`websocket_server.py:247-259`),丢失失败环节。

**关键路径的可重建性评估**

| 路径 | 能否重建 entry/decision/selected path/failure/elapsed |
|---|---|
| Adapter → 前端入站 | 部分。类型与 turn 可追,失败常被降级为泛化 `control.error`。 |
| 动作编译 (TS) | 是。`diagnostics.ts` + `parameterActionPreview` 记录了编译过程(Motion Lab 可见)。 |
| 动作编译 (C++) | **否**。`CompileMotionPlan` 无诊断输出,失败静默。 |
| 播放时钟与 sink | 是。`playbackTimelineRuntime` 记录终态。 |
| Spout 输出 | 是。`recordStats:132-162` 纯数值累加,10s 输出一次,含节流与闸门状态。 |
| ESP32 输出 | **否**(见上)。 |

**设计意图注释的缺口**:`main.py:53` 的反向布尔、`motionRuntimeScheduler.ts:288` 的 mismatch、Adapter 各类白名单的取舍,均无"为什么"注释,只有"是什么"。符合框架要求的注释(解释约束与可移除条件)在仓库中基本缺失。

---

## 11. Architectural Simplification Opportunities

按 `delete > merge > converge > refactor > new abstraction` 排序:

1. **delete** —— `buildInboundEventContext` 死参数及其每消息构造;`useDesktopWindowActions.ts` 透传壳;根 `package.json`(确认为残留后)。
2. **converge** —— 终态枚举与 `isTerminal` 谓词单一化,消除 `interrupted` 的词表分歧。
3. **converge** —— `normalizeTurnId` 6 份实现收敛到 `core/turnIds.ts`。
4. **converge** —— 段身份:一个携带规范化 `turnId`/`messageId` 的对象,替代 `timelineId` 字符串拼接与 `playbackTurnId` 兜底。
5. **converge** —— 协议版本:让 C++ 从 `schema_manifest.json` 派生,并把该约束纳入校验脚本。
6. **merge** —— inbound 两张同构 switch 合并为一张;`motion_lab_raw_event_recorded` 归入 feature dispatcher。
7. **merge** —— `DesktopMotionCompileDiagnostics` 用类型别名替代手工克隆,消除已发生的漂移。
8. **refactor** —— profile 校验与预览 plan 编译器移出视图(成为 model-engine 可消费的单份实现);顺带消除 C++ 侧正在复制的第三份语义。
9. **refactor** —— 快照构建单一归属;去抖改最大间隔;`lastSent` 改游标,消除三重深拷贝。
10. **refactor** —— `useAdapterConnection.ts` 按职责拆分(transport / port / service)。

**不建议**:新增 manager / adapter / facade 层。仓库的分层已经足够,问题出在收敛而非扩张。

---

## 12. Potential Delete List

| 项 | 路径 | 置信度 | 消失后什么会变 | 移除前需验证 |
|---|---|---|---|---|
| `buildInboundEventContext` 死依赖 | `inboundDispatcher.ts:113`、`inboundEvents.ts:180`、`adapterInboundRuntime.ts:94-98,159` | High | 无行为变化(4 个消费者本就不读) | `test:inbound-protocol`、`test:inbound-events` |
| 透传壳 | `frontend/src/desktop-bridge/useDesktopWindowActions.ts` | High | `DesktopWindowPanel.vue` 改直调 preload | typecheck + 手动最小化/关闭 |
| 根 `package.json` | `package.json` | Medium | 需确认无工具从根运行 npm | 确认构建脚本入口 |
| 第二份 diagnostics 类型 | `types/desktop.ts:161-228` | Medium | 改用源类型别名 | typecheck;注意已丢失字段需补回 |
| 第二份 system 白名单 | `frontend_system_service.py:39-50` | Medium | 改为引用 `constants.INBOUND_ALLOWED_TYPES` | 对应测试 |
| manifest 游离版本 | `scan.py:164` | Medium | 并入 manifest 或明确标为非协议 schema | 前端消费方确认 |

---

## 13. Refactoring Order

**Phase 1 · 已确认删除(无行为变化)**
`buildInboundEventContext` 死参数 + 每消息构造;`useDesktopWindowActions.ts`;确认后删根 `package.json`。全部有现成测试或 typecheck 覆盖。

**Phase 2 · 概念与契约收敛(风险最低、收益最高)**
终态枚举 + `isTerminal` 单一化 → `normalizeTurnId` 收敛到 6→1 → 段身份对象化 → diagnostics 类型改别名。这四项互相独立,可并行;完成后 P1-3/P1-4/P2-9 的 P1 部分全部消除。

**Phase 3 · 责任归属**
协议版本单一来源(manifest → C++ 生成 + 校验脚本扩展)→ profile 校验与预览编译器移出视图 → 快照构建单一归属 → `useAdapterConnection.ts` 按职责拆分。**Phase 3 的第一项同时缓解 P0-1,是迁移继续推进的前置条件。**

**Phase 4 · 兼容与兜底移除**
`core_compatibility` 降级路径加日志(先可观测再判断)→ `main.py:53` 反向布尔重命名 → `turn_coordinator.py:566-574` 的 `getattr(..., True)` 默认值改为显式 → `_validate_payload` 补全 4 类 system 分支 → 二次规范化 `output_segment_coordinator.py:474` 移除 → `payload_validation` 异常文本统一截断。

**Phase 5 · 调用链简化**
inbound 两张 switch 合并 → ESP32 `enabled` 与错误状态单一化 + 设置单例 teardown → 媒体获取失败段内降级并保证清理 → turn 终态后端单一持有。

**Phase 6 · 观测与文档(贯穿全程)**
ESP32 7 条失败路径接入日志 → 模型扫描失败发 `control.error` → 段身份不匹配日志加上下文 → 架构文档结构图补入原生平面并说明边界 → 修正 `_conf_schema.json:44` 与 `README.md:16` 措辞。

**贯穿项**:原生迁移的架构决策(双运行时长期并存 vs 完全替换)应在 Phase 3 之前明确 —— P0-2 的处置方向完全取决于这个答案,现在继续写 C++ 编译器会扩大而非缩小差距。

---

## 附:本次审计未覆盖 / 未验证

- **未运行** `npm run typecheck`、`npm test`、`pytest`、CMake 构建。所有结论基于源码静态阅读与调用关系。
- **未取证**:`vts-data-recorder/`(独立 VTube Studio 录制器,23 文件)、`tools/validate_runtime.py`、`native/spout/` C++ 源码、Spout Sender 构建脚本。
- **无法验证**:`core_compatibility` 兜底在目标 AstrBot 版本是否命中(仓库未 vendored AstrBot);浏览器 Private Network Access 是否实际阻断 P7 的跨域读取;`F6` 非法 phase 转换的异常在 Vue watcher 中的实际传播路径(需运行时)。
- **工作区状态**:审计开始时 `git status` 显示 4 个已修改文件(`.gitignore`、`render-core/CMakeLists.txt`、`render-core/README.md`、`render-core/src/main.cpp`)—— 均为你自己的未提交改动,本次审计未修改任何文件。
