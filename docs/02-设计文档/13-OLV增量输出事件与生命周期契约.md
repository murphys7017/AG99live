# OLV 增量输出事件与生命周期契约

更新：2026-10-17。本文是当前事件、容量与生命周期契约；实施状态和职责见 [12 实施计划](12-OLV全生命周期流式实施计划.md)，跨仓库剩余工作见 Core 的 `docs/Yakumo/dev/structured-persona-output/14-olv-remaining-work-and-acceptance.md`。

Core、Adapter 和桌面已接通增量文本/PCM/动作 update，并实现双端信用、动作特殊状态及期限；已有局部验证，真实 Provider、Electron 播放和 Live2D 尚待联合验收。沿用现有 Turn/时间线，能力由既有 OLV 设置门控，增量输出尚未登记为独立公开能力。动作小记录/revision/anchor/融合仍是后续设计。

## 下行音频容量契约（olv.audio_credit.v1）

- `system.server_info.schema_manifest.schemas.audio_credit` 必须为 `olv.audio_credit.v1`；桌面现有严格 manifest 校验会拒绝不匹配版本。桌面在 `system.desktop_runtime_settings` 同时发送 `audio_credit_schema=olv.audio_credit.v1`，Adapter 验证并记录在本连接；断开即清除。未协商不得建立 M2 writer，不新增用户开关。必须配套加载 Adapter 和桌面，不能单独更新一端后视为可运行。
- 现有二进制容器和 `olv.incremental_output.v1` 三资源事件不改版本；新增前端→Adapter 的 `control.audio_credit`。外层仍为 v2、`source=frontend`、目标 frontend `turn_id`。payload 为 `{schema_version:"olv.audio_credit.v1", core_turn_id, persona_result_id, released_bytes, released_frames}`，累计值从每个 writer 的 0 开始，必须为非负安全整数，字节数为偶数。
- 每个结果初始最多允许 **128 KiB PCM 字节且 64 个 PCM 帧**在途。两项都满足才可发送下一帧；按实际拆分后的二进制帧计数，不能按 Provider 原始 chunk 数计数。metadata 每帧仍有 64 KiB 上限，帧数窗口同时约束其开销。文本、动作和控制不消耗音频信用。
- 桌面按线序同步验证身份、seq、offset 和容量，写入 Store 后，将 PCM/音频 end 放入同一串行 worker。接收函数随即返回，不等待设备准备、四秒播放缓冲或前段 drain。worker 只在 PCM append 已被播放器接纳后归还该帧容量；这不是实际播完回执。实际声音仍由既有播放器/时钟消费，不新增播放器或音频时钟。
- worker 容量最多为 64 个 PCM 帧加 256 个段结束记录，PCM 字节遵循上述窗口；不能用无限 Promise 链存储音频。后段 PCM 仍等待前段音频 drain；字幕、动作与生成终态可先推进。`synth_finished` 禁止新生产，但不能使已经接纳的音频过期；只有 Turn 打断、终态或连接代次退休才能取消消费。
- Adapter 按 frontend/Core/Persona 身份检查回执；累计值不能超过已预留发送量，旧/重复累计值不重复加信用，不接受一项回退另一项前进。已退休 Turn 的迟到回执不创建 writer。等待信用时不持有 text/audio/motion 共用发送锁。连续 30 秒无可用容量时明确报告 `incremental_audio_credit_timeout`；不静默丢包、不重发歧义帧。
- Turn 退休与断连会唤醒后端信用等待；桌面取消会清空待消费队列并终止等待，旧 worker 不能修改新代次。异步播放失败沿用原有显式失败、音频/时间线清理和断连路径，不吞掉异常继续宣称成功。
- 本地真实 WebSocket 验证经过 Python writer/TurnCoordinator 与编译后的 TypeScript transport/Store/worker：容量满时文本先行；首帧归还后续传第三帧；第二帧消费阻塞时仍接收 `synth_finished`，之后排空三帧并完成回执；超额信用被拒绝；连接 reset 唤醒信用等待。音频 sink 为隔离接纳桩，没有真实 Provider、声卡或 Live2D。完整 Electron 构建通过，不代表现场首响或听感已验收。

## 动作期限与无音频结算（同日修正）

动作生产默认 5 秒，遵循配置（上限 60 秒），并受 Core Turn 剩余预算约束；不再强制 750 ms。intent-ready 创建绝对 deadline，context、并发槽、Provider 和交付只用 remaining；Core 从平台事件读取同一已登记 deadline，不再额外截成 1 秒。未准入动作 producer 时，空动作资源立即正常结束。终态仅代表生产结束，不等于身体执行完成。

明确无音频的增量段复用 `motion_only` 时间线，不重播文本、不填静音。音频失败或语音窗口已结束时，尚未释放的动作明确拒绝并结算；本段音频仍运行时，后到动作可在全局 blocker 检查前接入。已释放或本地已结算的动作不能被迟到 update/end 重新打开，合法迟到事件仍推进生产 seq。真实身体动作及连续段交接仍需现场验证。

真实 model app 的默认 speech-only 动作准入也检查 motion stream：open 时不准备/启动默认动作，防止在语义动作生成期间预占身体。它与普通段 `motion.pending` 使用同一准入回调，不能只改一个隔离播放器而遗漏正式 app。

## 身份与协商

- 协议信封继续使用 v2。`turn_id` 使用桌面可识别的外部 Turn 身份；另携带 `core_turn_id`，禁止把两者混用。
- 流的身份为 `(turn_id, persona_result_id, segment_index, stream_id)`。`segment_index` 从 0 单调增长，总数在生成期间可未知。
- 每条流 `seq` 从 0 开始严格递增；start 为 0，data/update 和 end 继续递增。生产结束只能出现一次；错误结束后不接受后续数据。同一流的重复消息不得再次播放。
- 信封 `message_id` 是本次事件的唯一 ID；`segment_message_id` 是目标段的稳定 ID，不能用每个事件的 message_id 新建播放段。
- `olv.incremental_output.v1` 当前作为内部已实现协议使用，但仍不登记为独立公开能力；实际准入由现有桌面 OLV 流式设置、Core 兼容性和连接绑定 writer 共同决定。真实 Provider 和桌面播放器的现场验收通过后，才能考虑公开能力登记。现有分段流开关不另加第二组用户开关。
- 同一 Turn 的同一内容只选择增量交付或现有完整 `output.segment.v6` 交付，不双发文本/声音/动作。v6 的 `output.segment_motion` 不得更新 M2 增量段。

## Adapter 发送所有权（2026-10-17）

`OLVPetPlatformEvent.open_interaction_incremental_output(persona_result_id=...)` 已由 Core producer 在 OLV 流头调用，并由现有桌面 OLV 流式设置设置内部准入标记。入口沿用现有外部 Turn 与 Core Turn 绑定，由 TurnCoordinator 校验，OutputSegmentCoordinator 保存唯一 writer。writer 共用该 Turn 的锁，发送始终绑定创建时的 WebSocket；不能改用最新连接或另建 Turn。

start、append、end 均等待实际发送，成功后推进序号与采样位置。发送取消或异常可能已部分到达客户端，因此封闭 writer，禁止按同一序号重试。PCM 输入块最多 1 MiB，按最多 64 KiB 的协议帧切分；后段 PCM 必须等待前段音频明确生产 EOF。音频容量受上文独立 credit 约束，不能仅依赖 socket 写入等待；等待信用不持有三资源共用发送锁。

三条资源必须分别明确 end，才能由现有输出协调器发布 synth_finished。动作 failed/cancelled 不使成功文本和音频失败，文本/音频失败则记入本轮合成失败。结束文本将已接受前缀加入既有聊天缓冲，不重发全文。播放完成回执必须在输出关闭之后处理；检查等待同一把 Turn 锁，避免快速客户端在 synth_finished 发送返回前回执而被误拒绝。已有 Turn 清理同时撤销 writer，后续调用拒绝；发送中途断开仍须由既有失败/打断路径终止该 Turn，不能尝试在另一连接重放。

真实 Python 协调器/本地 WebSocket 与桌面 transport/Store/worker 已完成协议边界验证，Core producer 有安全文本、PCM 与动作 update 边界检查；使用隔离 PCM/身体 sink。已有 audio_credit 双端协商不等于独立公开能力登记，局部回执/排空验证也不等于真实设备和 Live2D 验收。

## 公共字段

每个事件 payload 包含：`schema_version=olv.incremental_output.v1`、`core_turn_id`、`persona_result_id`、`segment_index`、`segment_message_id`、`stream_id`、`seq`。索引和序号是非负整数，所有身份字符串非空。`segment_index` 不依赖最终段数。

`stream_id` 由对应资源所有者创建，文本、音频、动作各自独立；同一段的三条流通过公共段身份关联，不能共用一个序号计数器。

## 文本事件

| 类型 | 特有字段 | 语义 |
| --- | --- | --- |
| `output.text_stream_start` | 无 | 建立该段的文本流；不要求动作结果和情绪字段已就绪 |
| `output.text_stream_delta` | `text` | 已完成流式清洗与结构校验的非空文本增量，按原文追加，不 trim 或重发全部前缀 |
| `output.text_stream_end` | `status`、`reason`、`text_length` | status 为 completed/failed/cancelled；非 completed 必须有 reason。长度按 Unicode 码点计算，客户端不能用 UTF-16 length 直接比较 |

Core 是文本生产状态的唯一所有者。复用 Persona 小记录协议：完整 speech_delta 记录闭合即可下发，不等待 segment_end；无需先开放未经解码的 JSON token。跨增量的隐藏标记/转义由同一流的过滤状态处理，最终 Hook 不能改写已提交前缀。

### 文本增量预处理

Core 现提供 `PreOutputProcessor.create_incremental_text_preparer(event)` 预处理入口：每个已解码 Persona 段创建一份状态，feed 返回本次可立即提交的新文本；跨 delta 的 system_reminder 标记和嵌套块不会泄露到显示/TTS。既有 Core 内容安全检查覆盖整个可见前缀，拒绝后保留已经接受的前缀。finish 只返回最终全文供校验，不是额外增量；未闭合的标记或标记前缀会使该段失败，不能跨 Persona 段闭合。单段原始输入最多 1 MiB UTF-8，可见文本最多 65536 UTF-16 单元，保留首尾空白并将连续换行限制为两个。该入口不执行整段 decorating Hook，避免重复副作用与撤回已提交文本；生产路径隔离旧整段修饰，不能在结尾重新改写此前已交付内容。真实运行中的 Provider、桌面和 Live2D 仍未现场验收。

桌面正式入站已接收文本 start/delta/end。SessionStore 注册增量段，保存完整前缀和独立流状态，delta 原样显示，end 校验 Unicode 码点长度并记录该段历史；生成终态与音频播放终态分别保存。同一 Turn 不混用完整 output.segment 与增量交付，旧完整段执行器不再释放增量段。每 Turn 最多 256 段、文本最多 262144 个 UTF-16 单元，每段最多 65536 个 UTF-16 单元；这些限制不改变 text_length 的码点计数。Core 的增量预处理已接入 producer，桌面身份/结构校验仍不能代替它。

当前 Persona segment_start 仍包含 actions/tendency；轻量段头先发身份、动作/情绪后置是待评估的协议优化，不能从文本 start 事件推断已经实现。turn_action 在可见回复前完成准入；最终段及流结束校验继续执行，失败保留已交付前缀并显式报错。

## 音频事件与二进制帧

| 类型 | 特有字段 | 语义 |
| --- | --- | --- |
| `output.audio_stream_start` | `encoding=pcm16le`、`sample_rate=32000`、`channels=1` | 首版固定格式，总时长未知；必须在第一帧前发送 |
| 二进制 audio chunk | 公共身份、`sample_offset`、PCM 字节 | 复用二进制帧容器的编解码约束，但明确为下行；携带 stream_id/seq 和完整段关联，不能只复制现有麦克风帧就视为下行已实现 |
| `output.audio_stream_end` | `status`、`reason`、`total_samples` | 表示不会再有新采样，不表示桌面已播完；EOF 后必须排空已接受缓冲 |

`sample_offset` 和 `total_samples` 按每声道采样帧计数。首帧 offset 为 0，之后必须连续；PCM 块长度必须为采样帧字节数的整数倍。传输可分包，禁止补发已播放采样、静默丢帧和把每包当独立 WAV 解码。

桌面同时核对跨段生产顺序：后面段的 PCM 只能在所有前面段均已明确 audio end 后接受；拒绝时不推进序号或采样。前面段实际播放尚未排空时，仍由时间线消费方等待排空；动作终态不参与这项音频等待。

下行容器固定为 magic=AG99、version=1、frame_type=2、flags=0、12 字节头与 UTF-8 JSON metadata，长度字段为 little-endian；上行麦克风仍为 type=1。metadata 最多 64 KiB，单个 PCM 块最多 64 KiB。元数据同时包含公共身份、外部 turn_id 和固定音频格式；chunk seq 从 1 开始（0 留给 start）。整数和末采样位置必须在 JavaScript 安全整数范围内。实际消费端还须检查每条流的顺序、连续 offset、start/end 与旧 Turn；单包解析通过不代替状态校验。

Core 是唯一 TTS 调用方。新 MiniMax 双向实现公开音频块与格式，不经过完整文件物化。一个在途合成会话由一个 Turn 持有，跨 Turn 复用连接须在取消/排空确认后切换生成代次。

当前只复用 MiniMax Provider 持有的 HTTP session/connector 资源，PCM 不再每轮构造新的 HTTP session；每次 get_pcm_stream 仍新建独立 WS 和 task，不做跨 Turn 合成复用或收费预热。Provider terminate 关闭共享资源，拒绝新的 PCM 流并唤醒在途流；Core consumer 用 aclosing 显式回收 PCM 服务迭代器。两次本地真实 WS 及发送中取消边界已通过，未测得外部网络加速数值。

AstrBot Provider 入口为 `support_pcm_stream()` / `get_pcm_stream(text_source)`：输入字符串立即追加，输入 `None` 请求段 flush，输入迭代结束请求 session finish；输出 bytes 为 PCM 块，输出 `None` 为本次段 flush 确认。消费方必须在打断时关闭输出迭代器。此接口与旧文件/WAV `get_audio_stream()` 区分，不能把聊天流能力或旧 WAV 队列能力当作增量 PCM 准入。

Core 语音服务入口为 `synthesize_pcm_stream(context, event, PCMTextPart 输入流)`，返回带 start/audio/end、segment_index、sample_offset 和音频格式的 PCMStreamFrame。输入必须是预处理完成的增量，服务不代替 Core 内容校验或最终交付收口。当前 Core OLV producer、Adapter 下行和桌面消费端已经连接；仍需真实运行时验收 Provider 首块、桌面首采样和播放排空。

第一版不跨 Persona 段合并合成归属：segment_end 时发送 task_flush；确认已接受文本对应的 sentence_end 和 task_flushed、当前音频尾部归属确定后，才把下一段文本送入同一 Provider 会话。下一段在 Core 有界队列等待，不阻塞主模型继续生成，也不阻塞当前音频传输/播放。实现时先验证 Provider 的事件顺序，不能把 is_final 当整轮结束。

桌面建立音频 stream sink，取代新路径对 audio URL 和预先确定总时长的依赖。按实际消费采样数建立播放时钟；暂停/欠载期间时钟不虚走。口型、音量、输出设备及动作时间锚点使用这个 sink，同一段不能产生两个音频播放实例。

桌面播放边界已提供 `SpeechOutputRuntime.attachPcm()`：先 prepare，再串行 await append(sample_offset, pcm)，最后 finish(total_samples)。completed 仅在 EOF 且已接受音频排空后成功；dispose 冻结已消费前缀、停止节点并唤醒等待追加。复用现有输出图与 analyser；采样时钟只累计实际播放区间，欠载间隙不计入。播放缓冲最多四秒采样与 128 个音频节点，单块最多 64 KiB；worker 传播该背压并通过信用限制网络在途量。350 ms 冷设备准备现可由麦克风输入开始提前触发，PCM prepare 仍复核同一输出图；不能再一概描述为首包后才开始预热。

会话音频运行时现提供 `openPcmForTimelinePlayback(turn_id, segment_message_id)`，返回串行 append、finish 与排空 completed；沿用现有 PlaybackTimeline 的音频/口型 sink 及 Turn 打断，调用前必须完成正式播放段注册和流身份准入。PCM `started` 在 AudioContext 开始消费首批采样后通知，同进程 performance 时间由音频上下文估算，不等同于硬件实际发声时间。prepare、排队与设备预热不算起播。finish 的 failed 状态需提供 reason，已接受前缀先排空再以原原因失败；取消由时间线打断立即停播。此入口已在桌面组合层装配并由正式 socket 入站及流式段存储调用。真实 Live2D 口型和指定输出设备尚未验收。

正式 socket 入站与流式段存储已连接：type=2 帧校验身份/seq/连续 sample_offset 后进入有界 worker；worker 在本段第一包创建播放器，空音频 end 则记为 absent。后段首包可以在信用窗口内先被接纳，实际消费等前段排空；音频起播不等 motion end。所有生产流关闭后允许 synth_finished 到达，已接纳音频继续播放，本地结算后才回执。打断/连接失败沿用 Turn 清理；Store 只取消仍 open 的生产状态，不改写已结束状态。动作 update 经校验后进入现有 sink；无音频可独立执行，已失败/过期动作不被迟到事件重开。提前输出预热已经接入同一输出图，真实首响收益仍待现场测量。

## 动作事件

| 类型 | 特有字段 | 语义 |
| --- | --- | --- |
| `output.motion_stream_start` | 无 | 为该段打开动作输入，不将 pending 当作 absent/failed |
| `output.motion_stream_update` | `motion_payload` | 已通过 Adapter/桌面动作契约校验入口的完整动作 payload；使用该 motion 流自己的 `seq`，允许在文本或 PCM 已开始后到达 |
| `output.motion_stream_end` | `status`、`reason` | 动作生产结束，可选动作失败不覆盖已成功交付的核心文本/音频 |

`payload` 使用现有可执行动作契约，由 ModelEngine 校验/编译，不直接写未经校验的 Live2D 参数。`profile_revision` 仍表示模型资源版本，不能替代这里的动作修订号。

Adapter 的 Persona 动作 Future 完成后发送 update，再发送 motion end；无结果或超时以带原因的 failed end 收口。update 仅用于已 start 且仍 open 的流，复用公共身份，推进该 motion 流的 seq；不能改写已结束流。桌面经 `normalizeMotionPayload` 校验后交给现有 PlaybackTimeline/ModelEngine；是否实际启动还取决于当前音频/独立动作时间线及有效窗口，不保证先于首音频。

后续 T6 的 `anchor` 设计候选为 `audio_sample` 或 `segment_now`，尚不是当前 update 的已实现字段。前者应携带目标采样位置，后者表示当前姿态上的短预览；不能使用两个进程各自的 monotonic 时间进行比较。后续修订与预览融合必须先定义同一参数控制权，不能把候选字段直接塞入旧 payload。

桌面当前按单一 motion 流的 `seq` 接受更新；流结束后拒绝迟到更新，Turn 终止后忽略旧身份。动作 payload 由 `normalizeMotionPayload` 校验，再交给现有 PlaybackTimeline/ModelEngine；实际动作融合、revision/anchor 细粒度替换和过期窗口仍属于后续扩展，不应把当前 update 接线误认为完整动作融合。

动作小记录是 T6 待实施目标。当前 reader 仍在 EOF 后解析完整 JSON，桌面已释放的 payload 不会被后续 update 替换。改造前需同步正式输出契约、增量解析、revision/anchor 和身体执行入口；不能只截取旧 JSON 前缀并声称逐条执行。聊天 Provider 在途请求不支持追加 prompt 时，应另行定义有界意图请求与合并规则，不每个字重启模型。

## 结束、期限与背压

桌面 transport 保持线序接纳，通用接收队列（含在途消息）最多 128 条、16 MiB，同时限制单包；二进制直接以 ArrayBuffer 接收。PCM handler 不再等待播放，而是验证后提交上文的有界 worker，双端信用控制音频在途容量。通用队列不是浏览器原生接收背压，溢出仍显式失败且不静默丢块。当前 Turn 的已校验 interrupt 可优先执行，未知/后续 Turn 不能越过 turn_started；本地先中断、服务端回执尚未到达的正常 PCM 退出不会触发连接故障。连接 reset 和新 Turn 代次会退休旧 worker。

1. 文本、音频和动作流独立结束。未返回动作不能提前登记为失败；音频起播不等待动作终态。
2. 移除把 0.75 秒同时作为首响等待和动作任务生存期限的设计。动作生产期限使用配置并受 Turn 剩余预算约束；音频不等待动作。到期需记录 context/gate/provider/parse 等实际阶段，不能只留下 motion_state=failed。
3. 音频已播放完但动作仍在合法窗口时，Turn 保持结算态；窗口关闭后取消尚未完成的动作并发出明确终态，不无限等待，不补播过期动作。
4. 所有生产流明确关闭后发送 control.synth_finished，不等桌面播放排空。桌面继续消费已接纳音频，全部本地播放任务结算后才发送 playback_finished；TurnCoordinator 最后发送 turn_finished。不能在文本或音频单支路结束时清理全部动作注册表。
5. 用户打断、断线或总期限到达时，由 Turn 所有者终止三条流与本地播放。已接受前缀保留为不完整结果；旧生成代次不得污染新 Turn。
6. 各队列必须同时限制条数和累计字节/采样量，单个超大块也计入容量。传输满时通过有界 await 背压；停止或失败必须能唤醒排队任务。首版具体容量随真实播放负载验证后冻结，不使用无界容器。

## 观测与第一批实测

同日新增 M2 观测：Adapter 每个 writer 的首个成功发送 text/PCM/motion 各记录一次，带 frontend/Core/Persona/segment/message 身份及 epoch，不记录正文；桌面白名单新增 `incremental_text_first`、`incremental_pcm_first`、`pcm_prepare_start/end`、`pcm_first_sample`、`pcm_drained`。前两项每结果一次，PCM 准备/消费项每段一次。`pcm_first_sample.monotonicMs` 来自 `output.started` 的软件消费估计；其估计 epoch 可按 `timeOriginMs + monotonicMs` 计算，`timestampEpochMs` 是回调记录时刻，二者不可混同为硬件声卡实测。尚无新现场样本，不据此给出收益百分比。

动作终态现分为 `motion_ended`（成功）、`motion_failed` 和 `motion_interrupted`，不再把失败写成 ended。历史日志中的 ended 可能是任意终态；没有对应 started 时不能算作实际动作成功。03:12 的 M0 首段曾出现这种情况，缺少当时的拒绝原因，未把它臆断为某个已修复问题的现场复现。

- 动作 Provider 请求必须记录 motion_request_id、core_turn_id、persona_result_id、segment_index；首块、流结束和合法结果共享请求 ID。deadline 日志注明实际阶段，区分没首块、已有增量但未闭合、解析拒绝和交付过期。
- 文本首增量、TTS 首块、Adapter 首帧、桌面首采样及动作首指令分别记录。跨进程记录 epoch，进程内耗时用本进程 monotonic；仅在同一时钟域相减。
- 2026-10-16 使用当前配置的 speech-2.8-turbo 与当前音色直连双向接口：连接约 578 ms，任务就绪约 610 ms，首 MP3 块约 797 ms（发送首批文本后约 187 ms），首块早于第二批文本和 finish；flush、cancel、finish 均收到确认。
- 独立的 PCM 编码验证通过：32000 Hz 单声道 format=pcm，首块 2048 字节，文本发出后约 234 ms 收到；块非 RIFF，采样边界对齐。共收到 78020 字节，flush/finish 正常。PCM 采样解释和实际播放还需在真实桌面验收，不能把这次网络边界检查当作已听到声音。
- 以上均为短文本单次实测，无 ASR、Persona、Adapter 下行和 Electron 播放，不代表首响 p50/p95，不建立硬编码超时目标。未改配置或重启应用。

官方接口依据：[MiniMax 双向流式语音合成](https://platform.minimax.cn/docs/api-reference/speech-t2a-websocket-bidi)。
