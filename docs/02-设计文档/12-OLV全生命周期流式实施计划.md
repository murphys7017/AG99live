# OLV 全生命周期流式实施计划

> **状态：2026-10-16 阶段 1 复核问题已修复，待真实联调。**入口配置的默认值仍为关闭；本文同时记录源码状态和未完成的运行验收。范围覆盖 AstrBot Core、AG99live Adapter Python 后端和 TypeScript 桌面前端；不涉及 C++。

## 当前进度

- **2026-10-16 整体复核修复：**Adapter 的请求、响应、结果修饰和完整 Persona 结果 Hook 已声明流式安全。动作 Future、并发任务和共享上下文现由 RuntimeState 的 `PersonaStreamMotionRegistry` 按后端 Turn 保存；交付、终态、打断及断线共享同一所有者，避免隔离 event extras 读不到任务。Core 在每次流式 Persona 调用结束（含异常和取消）后清除 `active`，`delegate` 后的普通 Core-final 回复恢复原有动作 Hook/contributor。流失败经 `control.synth_finished.success/reason` 传到桌面；已接受前缀继续播放，最终播放回执及 `turn_finished` 保留失败。相关基础提交：Adapter `f11a86c`、`fe4d1b1`，Core `75012004d`。
- **复核验证边界：**真实 AstrBot 生命周期及 OLV 发送检查已确认跨上下文动作汇合；真实段输出和协议回执边界已确认保留前缀、失败关闭、成功客户端回执不能覆盖生成失败。前端协议→Session→完成回执检查确认前缀结算前不回执、结算后回失败，并拒绝缺少原因的失败终态。上述检查未调用真实 Provider、音频设备或 Live2D，不替代首响、取消及委派最终回复的现场验收。
- **联调前仍需处理的兼容限制：**按用户最新要求，OLV 核心对话优先：未声明流式安全的旧 Hook 在该次流式调用中跳过并记录原因，不能因其存在而拒绝整轮；旧完整结果 contributor 和当前不支持的 Persona effect 同样排除。已适配 Hook 正常执行，不能把跳过说成插件已兼容。NeuroBrain 结果 Hook 经源码复核只观察完整终态、异步提交状态，不改写已发布段或停止事件，现已补充对应安全声明；仍不提供逐段状态更新。必须配套加载新版 Core、Adapter、NeuroBrain 插件和桌面端，不能把源码部署等同于运行时生效。
- **2026-10-16 二次审阅：**前三个修复提交和失败终态链路继续保留。真实解析→Core 交付→OLV 事件→Adapter 输出边界检查额外发现并修复非 TTS 分支：状态段不能跳过已分配的 Persona 索引；逐段物理交付必须使用该段 ID，不能复用父 ID；没有 TTS 物料时不能发送要求 TTS 身份元数据的 `audio_attachment`。修复后状态段及后续文本段按 sequence 0、1 完成交付。该检查未生成真实动作或音频，不能作为表演效果或端到端验收依据。按用户要求，NeuroBrain 兼容改造不作为本轮继续推进的必选项；它的现有准入限制仍有效。
- **2026-10-16 00:59–01:00 现场失败：**两次 OLV 输入均完成转写并请求流式，随后在模型调用前被 `persona_stream_output_hooks_unsupported` 拒绝；并行控制再抛出 `Parallel Interaction control resolved without route`，未向桌面收口。桌面仅有 capture-end，无 playback-start。根因是预检查统计了全局已停用的 AngelHeart 输出 Hook，且发布前失败未被并行无路由分支消费。Core 现按实际 capability/runtime-target 准入选择参与兼容检查的 Hook，并记录具体不兼容 handler；发布前失败会直接 abort OLV Turn 并传递原始错误。此前对启用中不安全 Hook 的整轮拒绝策略，已由后续“核心对话优先”的调用期隔离策略取代。现场没有进入 NeuroBrain 回调，不能把这两轮失败归因于 NeuroBrain。
- **2026-10-16 根因复核补充：**撤回临时停用 NeuroBrain 的联调建议。其终态结果 Hook 缺少安全声明是修正输出预检查后可预见的下一处准入问题，已按实际语义补齐，而非跳过回调或放宽 Core 规则。源码仓库及已部署插件分别验证真实注册元数据和终态回调：声明存在、结果不被改写、事件不被停止；无 checkpoint 的提交按现有逻辑完成。未调用真实模型推理或验证播放。部署目录另有既存加载/Persona 解析改动，保留原样，仅同步本次声明。动作链等候对应终态状态最多 1 秒，流结束前可能取不到状态，是首段延迟及状态可用性限制，不是本次无限思考的根因。下一步手动重启 AstrBot，保持 NeuroBrain 启用，验证正常输出、失败终态及首段播放时序。

- **2026-10-16 用户确认核心对话优先：**Core 不再因可选插件未适配而停止 OLV 流式对话。实际 lifecycle/decorating 调用点执行统一安全声明筛选，未适配 Hook 不会在预检查放行后再次执行；旧完整结果 contributor、Persona effect 在筛选或解析参数前排除。每次流式调用开始重置跳过记录，日志输出 `DIAG persona_stream.plugin_skipped` 及具体能力，调用结束清除 active，普通回复与委派 Core-final 的生成 Hook 恢复既有行为。两项公开边界检查及真实解析→Core→OLV→Adapter 段交付检查通过；无真实模型、TTS 或播放验收。
- **2026-10-16 提交后审阅修复：**发现结束阶段遗漏：生成结束清除 active 后，旧 `after_message_sent` Hook 仍能停止事件，使 `complete_visible_delivery` 提前返回、桌面收不到结束通知。公开边界已复现。该终态 Hook 现额外读取本轮流式结果状态，跳过未声明安全的回调；普通生成 Hook 仍只按 active 隔离。修复后 3 项相关边界检查通过，普通非流式结束行为保留。再次审阅未发现新增阻断项；补充本地真实解析→Core→OLV 事件→Adapter 检查，确认状态段和文本段按序交付，active 清除后未适配的发送后 Hook 被跳过，并实际构造发送一条对应 Turn 的 `control.synth_finished`。该检查未调用 Provider、TTS 或播放器，孤立环境的模型/MotionLab 缺失诊断不属于现场失败。Core metadata 及后台 zh/en/ru 开关说明同步修正为“受支持平台”和“OLV 跳过不兼容插件”；未重建后台页面资产，不影响 Core 修复加载。现场模型、TTS、播放及打断验收仍待手动重启后进行。

- **2026-10-16 01:41 现场失败及修复：**本轮在模型调用前被 `provider_stream_unsupported` 拒绝。根因是 Core 用 TTS 专用 `support_stream()` 判断聊天 Provider，错误拒绝了实现 `text_chat_stream()` 的 DeepSeek；现改为检查聊天流接口的实际实现，并排除仅继承基类未实现占位方法的 Provider。连带的 `persona_stream_terminal_identity_invalid` 来自 header/结果 ID 建立前的无身份 stream-finished 通知，现不向 Adapter 发送该通知，由 Core 按原始原因结束未发布 Turn。两项定向能力/输出边界检查通过。另使用现有配置独立直连 DeepSeek flash 和 MiniMax M3.1 Flash Preview，均收到真实流式增量和最终响应，确认接口支持；这两次为独立诊断请求，未经过完整 Persona/TTS/播放链，不能作为阶段 1 验收。未重启运行中的 AstrBot，用户需手动加载修复后继续对话取证。

- **阶段 0 观测点：已接入并完成首次桌面关联采样。**现有语音路径记录 PTT 采集结束、转写开始/完成、Persona 完整结果或校验 segment、TTS 完整物料就绪、Adapter `output.segment.v5` 发送和桌面实际音频起播。浏览器侧 PTT→实际起播使用同一 `performance.now()` 时钟；进程间阶段同时记录 epoch 时间戳，并按 `turn_id` / segment 身份关联。
- **阶段 0 基线：已建立初步端到端基线，分布仍待补充。**2026-10-15 19:25、19:26 两轮普通 OLV PTT 对话的 PTT 松开→桌面首个实际起播分别为 **6.514 s**、**5.741 s**；PTT 松开→首次服务端 `output_segment_sent` 分别为 5.937 s、5.534 s。首个输出提交→桌面起播分别为 0.577 s、0.207 s。对应 ASR 完成耗时分别为 0.784 s、1.110 s（从服务端 `transcription_started` 起算）。两条真实端到端记录满足开始阶段 1 的基线前置条件，但样本量不足以报告稳定 p50/p95；后续联调期间继续采样。此前另有 3 条服务端样本，从 `transcription_started` 到首个 `output_segment_sent` 为 5.673 s、4.908 s、5.466 s；该指标不能替代 PTT→桌面起播。流式入口仍保持关闭，未改变当前交互路径。
- **阶段 0 采样取数：**Core/Adapter 服务端 `DIAG latency.*` 从 `data/logs/astrbot.log` 按 `turn_id` 关联；Electron renderer 的 PTT capture end 与 audio playback started 经受限 IPC 写入 `app.getPath("logs")/ag99live/olv-latency-YYYY-MM-DD.jsonl`，只包含时间、Turn/stream 身份和采集状态，不含对话正文。已从 2026-10-15 的桌面 JSONL 成功关联两轮记录。
- **部署与样本备注（2026-10-15）：**用户更新并运行桌面端后，Electron JSONL 与 AstrBot 服务端日志已按两条 `input:turn_id` / `stream_id` 成功关联。第一轮 segment 0 的动作终态为 failed，日志原因为 `motion_step_duration_weight_invalid:0`；该轮音频首响时间仍可用于音频延迟观察，但动作同步表现异常，第二轮动作正常。继续采样时需同时观察动作终态，不能只看首响数值。
- **阶段 1 前置准备：已提交。**Core 的 result contributor 注册现支持可选 `event_filter`；AG99live 在 Core 支持时注册带过滤器的 motion contributor。Adapter 单独检查该能力，没有该能力的 Core 不满足 OLV 流入口条件。相关基础提交：AstrBot `839afa045`、AG99live `fb61dd9`。
- **阶段 1：Adapter 流式段身份、未知总数、动作 Future 汇合和默认关闭准入已接入；真实联调未通过。**流式段按单调 `persona_segment_index` 进入 Adapter；Core stream-finished Hook 到达后，Adapter 按最终 count 校验完整流或失败前缀。Core 在 segment-ready 时启动对应动作 Future；同段完整 TTS 物料到达 Adapter 后再汇合，完整结果 Hook 不重复启动整批动作。Adapter 侧开关现由前端“桌面端本机配置”中的 `persona_segment_stream_enabled` 持久化，每次连接建立与设置变更时通过 `system.desktop_runtime_settings` 主动同步到 Adapter；Adapter 按连接保存最新值、断线时重置关闭，每轮 OLV 事件读取当前连接状态；它默认关闭，不再位于 Adapter 插件配置。准入还要求 Adapter 独立动作、`per_speech_segment`、Core contributor event-filter 和 Persona stream hooks；AstrBot Core 的 `interaction_middleware.persona_segment_stream_enabled` 是第二道总开关。任一开关关闭都保留普通完整 Persona/动作流程。Core 会先完成 OLV 输出交付、再通知 stream-finished，因此 Adapter 在两者都到达后做终态校验。
- **2026-10-15 21:48 两轮日志复核：未进入流式入口。**Core 与 Adapter 配置文件中的旧开关值为 true，Persona 路径及逐段动作路由正常，但没有 `persona_segment_stream_requested` / `request_skipped` 记录；两个 Turn 均在完整 Persona 结果到达后输出一个候选段。由于设置与 Adapter 重载发生在同一秒，日志不能确定运行时是否读取到新值。Adapter 侧准入值已迁移到前端桌面本机配置，并扩展每轮日志以显式记录 `persona_segment_stream_enabled`。审阅还发现 Broker 快照只在控制页查询后才更新，会让重载后的已保存开关失效；已改为连接及设置变更时主动同步，不再以页面缓存决定运行准入。下一步需部署更新后的前端和 Adapter，在桌面设置页启用该项，再验证首段提前交付、双开关启停及取消/迟到拒绝。

上一轮复核发现并修复了兼容门过宽的问题：基础 interaction contributor 支持现与 `event_filter` 流式能力分开判断，旧签名 Core 继续注册普通路径 contributor。阶段 1 当前 Adapter 准入/动作/输出定向测试 43 项通过，Core 流式准入路径测试 60 项通过；Adapter Python 编译、插件结构检查（0 错误、0 警告）、配置 Schema 解析和两仓库 `git diff --check` 通过。上述测试为先前实现的定向验证；本次设置迁移通过 Renderer 类型检查、设置 responder 和门控边界检查，以及 Electron 与隔离输出的控制页生产构建。真实 `handle_msg` 边界检查确认布尔同步可直接控制下一轮 OLV 准入，字符串值被拒绝且不改变开关。运行中的前端及 Adapter 尚未加载本次迁移，真实流式首响验收仍待完成。

## 方案边界与初版复核依据

当前下一步是阶段 1 的配套版本真实验收，阶段 2/3 尚未进入实现。手动加载新版 Core、Adapter 和桌面端后，按以下顺序取证；本轮不自动重启应用或启用开关。

| 检查 | 通过依据 |
| --- | --- |
| 连接及开关 | 桌面开启“OLV Persona 分段流式”、Core 总开关及逐 speech 独立动作后，连接日志出现 `desktop_runtime_settings_synced persona_segment_stream_enabled=True`，下一轮出现 `persona_segment_stream_requested`。不兼容 Hook/contributor/effect 应出现 `persona_stream.plugin_skipped` 并继续生成、交付和结束；已适配动作 Hook 正常运行，不能再因旧插件存在而拒绝整轮。 |
| 双段首响 | 请求明确分成两段回复；关联 Core segment-ready、Adapter `output_segment_sent` 和桌面 `audio_playback_started`。段 0 必须在整轮 Persona/合成结束前实际起播，段 1 按序播放。只有文本先显示不算通过。 |
| 中断及重连 | 第一段播放期间 PTT 打断，再断线重连；旧段、旧动作不能进入新 Turn，重连自动同步本机开关。 |
| 后段失败 | 在可控环境让 Provider 后段失败；已接受前缀保留，关闭队列消息带失败原因，本地播完后回失败，最终 `turn_finished` 不得成功。 |
| 关闭开关 | 分别关闭桌面入口和 Core 总开关，再进行普通对话，完整回复及动作路径必须仍可用。 |

本文把“第三条链路”拆成两个层次：业务链路指现有三种动作路径中的 `independent_motion.enabled=true` 且 `per_speech_segment=true`，它保留 Persona 回复并按 speech 段绑定独立动作；实现层的流式运行骨架借鉴 `passive_behavior` 的异步读取、逐条校验、序号分配、取消、TTL、Turn 收口和即时提交方式。不能复制 `passive_behavior` 的独立后台 Turn、motion-only `output.segment.v5` 语义，也不能让新链路绕开正常 Persona 会话、TTS、动作和播放生命周期。

以下六项记录的是阶段 1 实施前的阻断点；当前状态以“当前进度”中的阶段 1 记录为准：

1. **OLV 流式入口还没有接通。** AstrBot Core 的 OLV Persona 流路径要求事件设置 `_interaction_persona_segment_stream_requested=True`，而 AG99live 当前 `OLVPetPlatformEvent` 没有设置它；因此真实 OLV Turn 不会自动进入 Core 的 OLV 分段流路径。
2. **AG99live 仍以完整 Persona 结果为动作入口。** `main.py` 当前主要依赖 `OnPersonaExpressionResultEvent` 读取完整 `result.segments` 后再启动动作任务；没有把 `OnPersonaExpressionSegmentReadyEvent` 接成逐段动作入口。仅声明 `persona_segment_stream_safe` 不能替代这次迁移。
3. **现有 Core OLV 路径仍然是完整段 TTS。** 它可以在 `segment_end` 后逐段调用现有 TTS，但当前 `synthesize_text()`/通用 Persona 语音路径仍物化完整音频文件；这不是实时音频块流。还必须避免 Core 和 Adapter 对同一段重复调用 TTS。
4. **段数协议尚未统一。** Core 的 OLV 分段物料会在流结束前缺少 `persona_segment_count`，而 Adapter 当前动作绑定、`_extract_persona_segment_metadata()` 和调度校验要求 `persona_segment_index/count` 成对出现。不能用“目前已看到的段数”伪造最终总数。
5. **现有 TS 播放路径是原子段路径。** `TurnPlaybackSessionStore.commitOutputSegment()` 和 `TurnPlaybackOrchestrator` 以完整文本、音频、动作三者均已解决为播放门槛；只要完整 `output.segment.v5` 已提前提交，现有编排器可以在 `synth_finished` 前释放该段，否则在尚无候选段时会等待后端终态。它没有音频 chunk、stream start/end 或有限音频缓冲状态。
6. **流式 Core 单测不能证明 OLV 集成完成。** 必须同时证明 AG99live 设置入口、逐段动作绑定、未知总数、首段提前投递、TS 提前起播、取消和迟到消息拒绝；`segment_stream_v1` 原型、`flush` 方法或单独的 TTS Provider 测试都不够。

因此，实施从一条紧密连接 Core Persona 生命周期、AG99live Adapter 和桌面播放时间线的 OLV 流式路径开始。先以“完整 segment + 完整音频物料”验证首段在整轮结束前到达桌面，再把该段音频从完整物料推进到真实 chunk 流，最后接入实时 ASR。全程沿用同一个 AstrBot Turn、Adapter `TurnCoordinator`、动作校验和 TS `PlaybackTimeline`；`output.segment.v5` 是第一垂直切片的桌面物料格式，不代表另建一套独立生命周期。

## 实施推进方式

按可验证的跨层行为分批完成，每批通过最小相关检查后单独提交。第一阶段的入口标记默认关闭；在逐段动作、未知总数关联、完整物料提前交付和桌面提前起播全部就绪前，不开放启用，不把“Core 已能解析 segment stream”单独记为阶段完成。

1. **契约与调用链冻结：**确认 Core 的 `OnPersonaExpressionSegmentReadyEvent` / stream-finished Hook、OLV `AstrMessageEvent` 输出物料、Adapter 内部动作绑定和 Adapter→TS 消息的字段与责任；建立当前首响时间戳基线。此批只更新契约和观测点，不打开新路径。
2. **Core 入口与逐段事件：**让 OLV 正常 Turn 能显式请求已校验 Persona segment 流；段 ready 和流终态都绑定原始 `turn_id`、`persona_result_id`、消息身份与序号。入口默认关闭，未闭合模型增量不外发。
3. **Adapter 逐段动作关联：**将新路径的动作工作从完整 Persona 结果 Hook 迁移到 segment-ready Hook；每段到达即登记动作任务，并与该段完整 TTS 物料关联。保留现有动作验证、失败终态、打断取消和迟到拒绝。
4. **桌面提前起播：**使用完整 `output.segment.v5` 物料逐段交付，先核验现有 TS 播放时间线能否在 `synth_finished` 前释放已完整提交的首段；若能，保持 TS 原子段语义不变，若不能，再只补满足提前起播所需的最小状态变化。
5. **启用第一竖切片：**Core、Adapter 和桌面端配套版本完成真实联调后，才允许打开 OLV Persona 流式入口；确认动作与 TTS 各只执行一次，首段在 Persona stream/`synth_finished` 前实际起播。
6. **连续 TTS 与实时 ASR：**第一竖切片稳定后，再分别实施音频 chunk 缓冲播放和实时 ASR；每一层保持同一 Turn 与播放时间线，分别验收后再进入端到端验收。

## 目标

让 OLV 的一轮语音交互从桌面采集到桌面播放都能按增量推进：

```text
PCM 麦克风帧
  -> 流式 ASR 的临时/最终转写
  -> AstrBot 正常会话与 Persona 生成
  -> 已校验 Persona segment
  -> 动作与 TTS 并行准备
  -> TTS 音频帧经 Adapter 送达桌面
  -> TypeScript 播放队列驱动音频、字幕、口型和动作
```

第一版以**完整且通过校验的 Persona segment**作为 OLV 可见、可合成和可播放的最小单位。模型 token 或尚未闭合的 segment 不进入 OLV 输出、TTS 或动作生成，避免已播内容无法撤回，以及动作与文本失去稳定关联。Core 现有 `speech_delta` 可以继续服务 WebChat；OLV 新链路只消费校验完成后的 segment 事件。ASR 临时结果可以显示，但第一版只将最终转写提交为一条正常 AstrBot 输入，不因每次修订重复触发对话。

为获得最快首响，流结束前允许总段数未知：Core 为每个已校验段分配单调 `segment_index`，Adapter 先按 `(turn_id, persona_result_id, segment_index, message_id)` 暂存和投递，最终 `segment_count` 只在流终态校验。新流式事件不能直接套用当前要求 index/count 成对的旧分段动作绑定器；兼容的 `output.segment.v5` 只作为完整快照或旧客户端出口，不能成为新链路首响的前置条件。

主要体验指标是“用户停止说话至桌面首个可听音频”的耗时，同时记录“首个有效 PCM 帧至首个临时转写”“语音段结束至最终转写”、首个 Persona segment、首个 TTS 音频帧和桌面实际起播时间。临时转写可能早于用户停止说话，不能用停止说话时间作为它的延迟起点。先建立当前路径的基线，再设定量化目标；不在缺少实测基线时承诺固定毫秒数。

## 当前基础与缺口

| 环节 | 已有基础 | 主要缺口 |
| --- | --- | --- |
| 麦克风上行 | TS 已分块发送 PCM，Adapter 已解析带序号的二进制输入帧；VAD 可逐帧检测。 | PTT 会缓存到音频结束；VAD 也在完整语音段形成后才调用 STT。 |
| ASR | AstrBot `STTProvider.get_text(audio_url)` 和文件型 STT 实现可用于最终识别。 | 没有统一的音频会话/增量识别接口；当前 MiniMax STT 适配器上传完整文件并读取完整文本。 |
| Persona | Core 已接入 OLV immediate Persona 的 `segment_stream_v1` 读取、结构校验及 segment-ready/stream-finished Hooks；Adapter 通过双开关准入，未闭合 delta 不外发。 | 尚未真实验收；不兼容插件能力按当前调用隔离并记录，Core 输出格式及交付校验仍有效。委派后的 Core-final 仍走普通完整结果路径，本轮仅修复其动作回归，不宣称该路径也已模型流式化。 |
| 分段动作与输出 | segment-ready 启动动作 Future，运行时注册表跨任务保存；逐段完整 TTS 到达后汇合，未知总数流在终态校验。普通路径继续使用原绑定器。 | 待真实双段、动作超时、后段失败、打断及断线验收；不能仅凭边界检查认定端到端时序正确。 |
| TTS | `TTSProvider` 已定义 `get_audio_stream()`；Agent 路径已有流式 TTS 消费代码，部分 Provider 内部使用上游流接口。 | Persona 通用语音服务仍调用 `get_audio()` 并物化完整文件；基类 `get_audio_stream()` 默认会先累积完整文本再生成整段音频，必须确认选定 Provider 真正支持音频分块；现有字节格式也不足以直接充当桌面连续音频协议。 |
| 桌面下行与播放 | TS 按完整 `output.segment.v5` 在 synth-finished 前起播，并拥有播放时间线、口型及播放完成回执；生成失败终态保留已接受前缀并影响最终回执。 | 仍以完整音频 URL 播放，没有音频 chunk 下行协议、连续解码 sink 或对应背压；这些属于阶段 2。 |

现有 `independent_motion` 的 `per_speech_segment` 路径提供业务关联、动作 Future、TTS 身份绑定和按段输出的基础；`passive_behavior` 的 NDJSON 动作流提供 Provider 流读取、校验、序号、取消、TTL、背压和 Turn 收口的运行时参考。新链路复用两者的对应部分，不复制后台触发条件或独立 motion-only Turn。

## 目标职责与身份

- **AstrBot Core**拥有正常会话、Turn、模型 Provider 流、Persona 解析、segment 校验和唯一一次 TTS Provider 调用/音频规范化。Core 通过进程内 Persona lifecycle Hook 与 OLV 平台事件交付已校验 segment 和该段完整 TTS 物料；流式实现复用或改造当前 Core TTS 分支，不允许 Adapter 对同一段重复合成。
- **AG99live Adapter**沿用现有 `TurnCoordinator`、动作生成、输出顺序和连接清理职责；通过 `OnPersonaExpressionSegmentReadyEvent` 收到完整校验段后登记对应动作任务，再将其与 Core 经 `OLVPetPlatformEvent` 交付的完整音频物料汇合。Adapter 不重复调用 TTS Provider。后续音频 chunk 由 Core 的流式 TTS 生命周期传入 Adapter，再由 Adapter 经当前 WebSocket 连接送到桌面，并传播背压、失败和取消；不创建第二个聊天 Turn。
- **TypeScript 前端**拥有 Turn/segment 播放状态、有限容量的音频队列、桌面音频输出和现有 PlaybackTimeline；以实际输出音频的时钟驱动口型和动作，不另建第二个播放时钟。
- **进程内 Core→Adapter 契约**由 Persona segment-ready/stream-finished hooks 与 OLV 平台事件共同承载，不新增一条伪装成 WebSocket 的 Core→Adapter 网络协议。段身份至少包含 `turn_id`、`persona_result_id`、`segment_index` 和逻辑 `message_id`；segment-ready 提供完整校验后的 segment，stream-finished 提供状态、最终段数和失败原因。Core TTS 的完整音频物料仍由原有消息物料化边界交付；未来音频 chunk 的进程内回调归属 Core TTS lifecycle。
- **Adapter→TS 桌面协议**第一垂直切片继续使用完整 `output.segment.v5`。真实音频流阶段再定义独立的音频 stream start/chunk/end 消息与二进制帧，包含 `turn_id`、`message_id`、`stream_id`、单调 chunk 序号及格式元数据。协议不得把含义不完整的音频 URL 塞入 `output.segment.v5`。
- `persona_segment_count` 在单段事件中可缺省，只在 `persona.stream_finished` 中给出最终值；Adapter 的新 stream assembler、动作候选校验和待交付状态必须允许流结束前总数未知，不得用当前已见段数伪造最终总数。成功终态校验段索引完整覆盖 `[0, segment_count)`；失败终态保留已接受的连续前缀及其实际数量。旧 `output.segment.v5` 路径继续要求完整段元数据，不通过隐式默认值兼容。
- 动作任务与该段 Core TTS 并发。为保留现有动作/音频同步边界，首段在动作结果和首个可播放音频帧均就绪后起播，后续音频帧到达后连续入队。播放顺序由 segment 序号决定，不由 Provider 完成先后决定。

## 实施阶段

### 阶段 0：冻结契约与建立基线

1. 为当前原子段路径记录“输入语音段结束、Persona 首段校验、首段 TTS 物料完成、Adapter flush、桌面实际起播”时间，建立首响基线；同时确认第一竖切片使用的聊天 Provider 与 TTS 配置。
2. 冻结进程内 Core→Adapter 契约：`OnPersonaExpressionSegmentReadyEvent`、stream-finished Hook、OLV 平台物料交付的身份字段、调用先后、失败/取消语义；明确不把未校验的 `speech_delta` 发给 OLV。
3. 冻结未知总段数规则：流中只接受单调且唯一的 `segment_index`；最终 `segment_count` 只由 stream-finished 提供；Adapter 只在流终态校验完整覆盖或失败前缀。现有要求 index/count 成对出现的普通路径继续保持原契约。
4. 确认第一竖切片仍用 `output.segment.v5` 交付完整段，输出段协议保持不变，另以 `system.desktop_runtime_settings` 同步桌面运行设置；AstrBot Core 总开关和前端桌面设置中的 Adapter 入口开关均默认关闭，直到 Core、Adapter、TS 与真实首响验收全部通过才允许正式启用。
5. 将 segment 级文本清理、动作登记、TTS 物料登记和终态收口纳入同一逐段契约；确认 Persona effect、全局 Hook、result contributor 在该模式下的支持条件；不兼容能力在实际调用前跳过并记录，不阻止核心对话。
6. 固定单段 TTS 只能由 Core 调用一次。阶段 1 继续使用完整音频物料；另行确认未来流式 Provider 是否能在完整合成前产出可播放首块，Provider 选择与音频格式冻结推迟到阶段 2。

**完成条件：**首响基线可从真实日志计算；进程内 segment-ready/stream-finished 与 OLV 完整物料交付契约明确；未知总数时的 Adapter 校验规则明确；入口标记保持关闭直到阶段 1 启用闸门满足。流式 TTS 格式及实时 ASR Provider 不作为本阶段的完成前提。

### 阶段 1：Core 到 Adapter 的 Persona segment 流

1. 实现默认关闭的 OLV Persona 流入口；请求标记只用于明确选择已完成的新路径，不能作为单独的可交付实现或默认启用配置。
2. Core 只在 `segment_end` 完成结构校验后触发 `OnPersonaExpressionSegmentReadyEvent`，提供完整 segment、稳定身份和单调索引；stream-finished Hook 提供最终段数及成功/失败/取消状态。
3. 将 AG99live 新路径的动作登记迁移到 segment-ready Hook：每段到达即启动对应动作 Future，保留现有动作校验、超时和取消；旧完整结果 Hook 不再作为新路径动作启动入口。Hook 不等待动作 Provider 完成，以免把动作延迟串进 Core 模型/TTS 生成。
4. Core 对每段只调用一次现有 TTS 物料化路径；Adapter 将 segment、动作结果和完整音频物料按稳定身份汇合，再逐段交付现有 `output.segment.v5`。如果现有物料回调不能让每段在整轮结束前独立到达，必须先修正 Core 输出边界，不能在 Adapter 里等完整 Persona 结果再拆分。
5. 允许流结束前总段数未知：Adapter 按 `(turn_id, persona_result_id, segment_index, message_id)` 暂存，流终态后校验 count、缺段、重复段及失败前缀；不把当前已见数量冒充最终 count，也不把未知 count 填入旧索引绑定字段。
6. 验证 TS 对已提交的完整 `output.segment.v5` 能在 `synth_finished` 前启动首段。只有真实联调证明端到端首段提前播放且动作、TTS 各一次后，才打开默认关闭的请求入口。

**完成条件：**真实流式聊天 Provider 下，segment 0 在 Persona Turn 结束前到达 Adapter，且其完整音频在 `persona.stream_finished` 和后端 `control.synth_finished` 之前触发桌面实际 `playback_started`；未校验 delta 未进入 OLV；每段只发生一次 Core TTS；未知总数期间动作、文本和完整音频仍可关联；最终计数与已接收段一致；段序不受任务完成顺序影响；中断后晚到结果不能重开 Turn。

**约束：**Core 流式仍要求特定结构化输出模式。按用户 2026-10-16 确认的优先级，OLV 流式调用跳过未声明安全的旧 Hook、旧完整结果 contributor 和不支持的 Persona effects；跳过必须记录能力名称和原因，不能让可选插件阻止核心对话，也不能宣称被跳过的能力已适配。已支持的 Adapter 动作与终态 Hook 保持运行，Core 内容安全、格式及交付校验继续执行。

### 阶段 2：TTS 音频帧到桌面连续播放

1. 本阶段选定并真实验证流式 TTS Provider；Core 在 Persona segment 路径调用一次，以有界队列逐块读取。若 Provider 实际只在完整文本后返回完整音频，则不得将其标记为流式能力。
2. Core 通过进程内 TTS stream callback 将音频 start/chunk/end 交给 Adapter；Adapter 增加有界发送队列及 WebSocket 二进制下行帧。每帧包含 Turn/segment/stream 身份、单调 chunk 序号和必要格式元数据。禁止无界积压和静默丢帧。
3. TypeScript 扩展现有 `TurnPlaybackSessionStore` 的事实模型，增加 stream start/chunk/end、有限缓冲、音频 sink 生成代次和失败终态；由现有 `PlaybackTimeline` 消费，不新建第二个播放时钟。
4. 首段的起播门槛是：segment 已校验、动作已进入成功/失败/absent 终态、收到首个可播放音频帧。后续音频继续入队；不等待整段 TTS、整轮 Persona 或 `synth_finished`。
5. 音频、字幕和动作以同一个 segment/音频时钟同步；Turn 中断时清空该 Turn 未播放帧并取消 Provider、Adapter 发送队列和 TS 缓冲。`output.segment.v5` 继续作为完整快照出口，不承载半成品 URL。

**完成条件：**首个音频帧在该段 TTS 尚未全部生成、整轮 Persona 尚未结束时已开始播放；慢网络能产生背压或明确失败；结束和中断均正确释放播放、口型与动作资源。

### 阶段 3：流式 ASR 输入

1. 为 STT Provider 定义音频会话生命周期：开始、PCM 帧输入、临时识别、最终识别、取消和失败；同时校验 `stream_id`、采样率、声道及帧顺序。
2. Adapter 收到麦克风帧后即送入已选实时 ASR 会话；临时识别允许修订，只更新转写显示，不创建多条聊天消息。最终识别只提交一次现有 AstrBot 消息。
3. 统一 PTT 与 VAD 的句段边界和 Turn 归属；新输入触发既有打断策略，并取消旧的识别、模型、TTS 和桌面播放工作。
4. 不把“上传完整音频文件后返回 SSE”当作麦克风实时 ASR；实时能力必须由选定 Provider 的接口和真实运行证明。

**完成条件：**采集期间收到可修订的部分文本，句段结束后得到唯一最终文本并只触发一条对话；丢帧、重连、空音频及取消有明确终态。

### 阶段 4：端到端验收与启用

按配套 AstrBot、Adapter 和 Electron 版本进行真实运行验收，覆盖至少双段回复、Provider 变慢/失败、ASR 修订、动作迟到、音频队列背压、PTT 打断、VAD 打断和 WebSocket 断线。确认音频播放时钟、字幕、口型、动作段序和 `turn_finished`/播放完成回执一致。

采集 p50/p95 的“停止说话至首个临时转写、最终转写、首个 Persona segment、首个音频帧、实际首响”时间，并与阶段 0 基线比较。功能验收要求确认音频实际在整轮生成/合成结束前起播；单元测试、类型检查和协议清单检查不能代替这项真实验收。

## 当前实现与计划的对应关系

| 现有实现 | 可以复用的部分 | 需要改造的部分 |
| --- | --- | --- |
| `runtime/passive_behavior.py` | 流读取、逐条解析、TTL、取消、序号和即时提交的运行骨架 | 去掉后台 motion-only Turn，改为绑定正常 Persona Turn 和 segment 身份 |
| `runtime/turn_coordinator.py` / `output_segment_coordinator.py` | Turn 锁、顺序 flush、迟到拒绝、失败终态及回执收口；未知总数由平台事件校验 | 阶段 2 增加音频帧发送、容量和背压状态 |
| `platform_event.py` | 双开关准入、逐段发送/flush、未知总数终态校验、运行时动作汇合 | 真实联调确认首段提前交付和取消；阶段 2 增加音频流生命周期 |
| `main.py` Persona hook | segment-ready 启动动作、stream-finished 清理、普通完整结果路径 | 其他插件 Hook 兼容审计与真实 Provider 验收 |
| TS `TurnPlaybackSessionStore` / `TurnPlaybackOrchestrator` | 已就绪原子段起播不等待 synth-finished；生成失败保留前缀并反馈失败 | 阶段 2 增加音频 stream 事实模型和 chunk 缓冲 |
| AstrBot Core `segment_stream_v1` | OLV immediate 入口、逐段校验、完整 TTS/物料交付、流终态及调用级 active 标记 | 实测当前竖切片；Core-final 模型流及真实音频流不在本次修复中 |

## 实施闸门

1. **入口闸门：**真实 OLV 事件设置入口标记后，Core 日志显示进入 OLV stream；未设置时仍走旧路径。
2. **段闸门：**segment 0 在模型流未结束时到达 Adapter，动作任务只启动一次，未闭合 delta 不外发。
3. **未知总数闸门：**流结束前可以投递段；流终态能拒绝重复、缺段、错误 count 和迟到消息。
4. **首响闸门：**完整音频垂直切片或首个音频 chunk 在 `synth_finished` 前触发桌面实际 `playback_started`。
5. **连续音频闸门：**慢发送、Provider 失败、chunk 丢失、重复和中断都有可见终态，没有无界积压或静默丢帧。
6. **真实联调闸门：**AstrBot、AG99live Adapter、Electron、真实聊天 Provider、TTS、ASR 和 Live2D 联调通过后，才把能力标记为完成。

## 失败、中断与资源规则

- 已经播放的 segment 不回滚；流后续失败时发送明确的 segment/Turn 失败终态，保留已播放前缀，不伪装成完整成功。
- 取消以 `turn_id` 为界并由各自资源所有者执行：Core 取消模型与唯一 TTS Provider 流，Adapter 取消动作任务和发送队列，TS 清除桌面未播放缓冲；终态向上下游传播，迟到消息按已终止身份拒绝。
- 每个排队点都设置容量和明确的超限行为。音频是不可丢弃的连续数据，禁止像普通 UI 状态更新一样合并或静默丢弃。
- 每类资源只有一个状态所有者：Core 收口 Persona/TTS 生成状态，Adapter 收口动作与传输状态，TS 收口实际播放状态。`control.synth_finished`/`turn_finished` 表示后端合成或 Turn 已结束，不代表桌面已播完；桌面播放完成以本地音频队列耗尽及相关动作终态为准，并通过独立回执上报。

## 待评审决策与非目标

1. 第一竖切片保留 Core 配置及逐段输出责任；用户已确定 OLV 核心对话优先，不兼容插件能力按调用跳过并记录，不能沿用“插件不兼容则整轮失败”的规则。
2. 为阶段 2 选定真实支持逐块输出的 TTS Provider，并冻结桌面可连续解码的采样率、声道、编码及二进制帧格式。
3. 为阶段 3 选定实时 ASR Provider；文件型 STT 或完整文件上传后的 SSE 不满足麦克风实时识别。
4. 冻结配套 AstrBot、Adapter 与桌面端版本启用策略；Provider/客户端不具备流式能力时明确拒绝启用，不静默宣称流式或降级成已完成。
5. 第一版不基于临时 ASR 文本推测启动模型。此类提前执行要先解决识别修订、撤销和副作用隔离，待真实延迟数据证明收益后再评估。
6. 不修改 C++ 原生运行时，不建立第二套聊天 Turn、动作播放器或播放时钟，不改变 `output.segment.v5` 现有语义。
