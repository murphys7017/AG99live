# OLV 全生命周期流式实施计划

> **状态：2026-10-15 实施顺序确认稿。**本文描述拟实施路线，不代表相关能力已经进入源码。范围覆盖 AstrBot Core、AG99live Adapter Python 后端和 TypeScript 桌面前端；不涉及 C++。

## 当前进度

- **阶段 0 观测点：已接入，待真实采样。**现有语音路径现在记录 PTT 采集结束、转写开始/完成、Persona 完整结果或校验 segment、TTS 完整物料就绪、Adapter `output.segment.v5` 发送和桌面实际音频起播。浏览器侧 PTT→实际起播使用同一 `performance.now()` 时钟；进程间阶段同时记录 epoch 时间戳，并按 `turn_id` / segment 身份关联。
- **阶段 0 基线：初步服务端样本已取得，完整基线未完成。**2026-10-15 的服务端日志中有 3 条到达首个 `output_segment_sent` 的语音输入链路；从 `transcription_started` 到首个 `output_segment_sent` 分别为 5.673 s、4.908 s、5.466 s。该区间不等于用户停止说话至桌面实际起播，不能替代计划指标，也不足以建立稳定 p50/p95。流式入口仍保持关闭，未改变当前交互路径。
- **阶段 0 采样取数：**Core/Adapter 服务端 `DIAG latency.*` 记录从 `data/logs/astrbot.log` 按 `turn_id` 关联；Electron renderer 的 PTT capture end 与 audio playback started 现在还会经受限 IPC 写入 `app.getPath("logs")/ag99live/olv-latency-YYYY-MM-DD.jsonl`，只包含时间、Turn/stream 身份和采集状态，不含对话正文。桌面源码构建和类型检查已通过；运行中的客户端需更新到新构建并重启后，才会生成这些记录。
- **部署检查（2026-10-15）：**首次检查时 AstrBot 进程早于诊断提交启动，计时标记为 0；用户手动重启后已采到上述 3 条服务端链路记录。
- **阶段 1 前置准备：已提交，尚未启用流。**Core 的 result contributor 注册现支持可选 `event_filter`；AG99live 在 Core 支持时注册带过滤器的 motion contributor，在旧签名 Core 上沿用原注册调用，因此普通 Turn 的 interaction contributors 和 Persona effect 不因该可选参数缺失而被关闭。Adapter 单独记录 `interaction_result_event_filter_available`；没有该能力的 Core 不满足后续 OLV 流入口条件，入口实现必须消费此标记。当前没有设置 OLV 流式入口。相关基础提交：AstrBot `839afa045`、AG99live `fb61dd9`。
- **阶段 1：未开始。**完成真实基线采样后，再实施 Core segment-ready Hook、Adapter 逐段动作关联、未知总段数处理和 v5 首段提前起播的完整竖切片。

上一轮复核发现并修复了兼容门过宽的问题：基础 interaction contributor 支持现与 `event_filter` 流式能力分开判断，旧签名 Core 继续注册普通路径 contributor。过滤能力标记已加入运行状态，但流式入口尚未实现对该标记的准入检查。当前验证覆盖新旧注册签名的边界测试和静态检查；尚无已重载配套运行时后的普通 Turn 或 OLV 实测。

## 本轮复核结论

本文把“第三条链路”拆成两个层次：业务链路指现有三种动作路径中的 `independent_motion.enabled=true` 且 `per_speech_segment=true`，它保留 Persona 回复并按 speech 段绑定独立动作；实现层的流式运行骨架借鉴 `passive_behavior` 的异步读取、逐条校验、序号分配、取消、TTL、Turn 收口和即时提交方式。不能复制 `passive_behavior` 的独立后台 Turn、motion-only `output.segment.v5` 语义，也不能让新链路绕开正常 Persona 会话、TTS、动作和播放生命周期。

当前真实状态有六个阻断点：

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
| Persona | Core 已有 `segment_stream_v1` 的模型流读取、结构化解析和 `OnPersonaExpressionSegmentReadyEvent` 发布点；OLV 输出会抑制未闭合的 `speech_delta`。 | AG99live 没有设置 OLV 流式入口标记；流式模式还受特定输出格式、全局钩子/贡献者和 Persona effect 限制。 |
| 分段动作与输出 | Adapter 已有 Turn、顺序、动作 Future、逐段 flush 和晚到结果清理机制；`passive_behavior` 有可复用的增量读取/即时提交骨架。 | Persona 动作当前从完整结果钩子启动；旧绑定器要求 index/count 成对，不能直接处理流结束前未知总数。 |
| TTS | `TTSProvider` 已定义 `get_audio_stream()`；Agent 路径已有流式 TTS 消费代码，部分 Provider 内部使用上游流接口。 | Persona 通用语音服务仍调用 `get_audio()` 并物化完整文件；基类 `get_audio_stream()` 默认会先累积完整文本再生成整段音频，必须确认选定 Provider 真正支持音频分块；现有字节格式也不足以直接充当桌面连续音频协议。 |
| 桌面下行与播放 | WebSocket 已支持双向消息循环；TS 有原子 `output.segment.v5`、播放时间线和口型同步。 | Adapter 出站抽象目前只发送 JSON；TS 播放器按完整音频 URL 创建 `HTMLAudioElement`，没有接收音频帧、有限缓冲、stream end 或音频播放回执状态。 |

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
4. 确认第一竖切片仍用 `output.segment.v5` 交付完整段，不新增桌面网络协议；入口标记 `_interaction_persona_segment_stream_requested` 默认关闭，直到 Core、Adapter、TS 与真实首响验收全部通过才允许开启。
5. 将 segment 级文本清理、动作登记、TTS 物料登记和终态收口纳入同一逐段契约；确认 Persona effect、全局 hook、result contributor 在该模式下的支持条件和明确拒绝原因。
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

**约束：**当前 Core 流式原型要求特定结构化输出模式，并拒绝部分全局钩子/输出贡献者，且不支持 Persona effects。阶段 0 必须明确 OLV 实际依赖哪些能力；所需钩子必须被纳入逐段契约或明确列为启用限制，不能静默跳过后宣称兼容。

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
| `runtime/turn_coordinator.py` / `output_segment_coordinator.py` | Turn 锁、顺序 flush、迟到拒绝、动作/输出终态 | 增加未知总数的 stream assembler 和音频帧发送状态 |
| `platform_event.py` | `send_message_with_extras()`、`flush_visible_segment()`、`complete_visible_message()` 和输出身份管理 | 设置 OLV 流式入口；不要让旧的完整结果拆分逻辑成为新链路首段前置条件 |
| `main.py` Persona hook | 旧完整结果链路、动作 Provider 和取消清理 | 增加 segment-ready/stream-finished 处理，按段启动动作，不再等待完整 Persona 结果 |
| TS `TurnPlaybackSessionStore` / `TurnPlaybackOrchestrator` | 事实状态、顺序选择、Timeline 和播放完成回执 | 增加 stream 事实模型和音频 chunk 缓冲；去掉新链路对 `synth_finished` 的首响依赖 |
| AstrBot Core `segment_stream_v1` | 模型流解析、segment 校验、逐段 ready hook | 接入真实 OLV 入口、逐段 TTS/物料事件和终态协议；保留 WebChat 专属输出路径不变 |

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

1. 第一竖切片的 Core 配置、Persona Hook/effect 限制和逐段输出责任由阶段 0 冻结，不作为实施时临时放宽的条件。
2. 为阶段 2 选定真实支持逐块输出的 TTS Provider，并冻结桌面可连续解码的采样率、声道、编码及二进制帧格式。
3. 为阶段 3 选定实时 ASR Provider；文件型 STT 或完整文件上传后的 SSE 不满足麦克风实时识别。
4. 冻结配套 AstrBot、Adapter 与桌面端版本启用策略；Provider/客户端不具备流式能力时明确拒绝启用，不静默宣称流式或降级成已完成。
5. 第一版不基于临时 ASR 文本推测启动模型。此类提前执行要先解决识别修订、撤销和副作用隔离，待真实延迟数据证明收益后再评估。
6. 不修改 C++ 原生运行时，不建立第二套聊天 Turn、动作播放器或播放时钟，不改变 `output.segment.v5` 现有语义。
