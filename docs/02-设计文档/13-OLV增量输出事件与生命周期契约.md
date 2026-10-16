# OLV 增量输出事件与生命周期契约

> 2026-10-16 第一批实施契约。事件名及身份规则在此冻结；尚未注册为可启用的桌面能力，不能据此宣称发送、播放或动作融合已经实现。沿用现有 AstrBot Turn、Adapter TurnCoordinator 和桌面 PlaybackTimeline。

## 身份与协商

- 协议信封继续使用 v2。`turn_id` 使用桌面可识别的外部 Turn 身份；另携带 `core_turn_id`，禁止把两者混用。
- 流的身份为 `(turn_id, persona_result_id, segment_index, stream_id)`。`segment_index` 从 0 单调增长，总数在生成期间可未知。
- 每条流 `seq` 从 0 开始严格递增；start 为 0，data/update 和 end 继续递增。生产结束只能出现一次；错误结束后不接受后续数据。同一流的重复消息不得再次播放。
- 信封 `message_id` 是本次事件的唯一 ID；`segment_message_id` 是目标段的稳定 ID，不能用每个事件的 message_id 新建播放段。
- 桌面与 Adapter 完整实现后才登记 `olv_incremental_output.v1` 能力；协商同时校验 Core、真实 Provider 和桌面播放器能力。现有分段流开关不能单独证明能力具备，也不另加一组用户开关。
- 同一 Turn 的同一内容只选择增量交付或现有完整 `output.segment.v5` 交付，不双发文本/声音/动作。新契约增加事件，不改变 v5 原子段含义。

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

桌面正式入站已接收文本 start/delta/end。SessionStore 注册增量段，保存完整前缀和独立流状态，delta 原样显示，end 校验 Unicode 码点长度并记录该段历史；生成终态与音频播放终态分别保存。同一 Turn 不混用完整 output.segment 与增量交付，旧完整段执行器不再释放增量段。首版每 Turn 最多 256 段、文本最多 262144 个 UTF-16 单元，每段最多 65536 个 UTF-16 单元；这些是本地容量限制，不改变 text_length 的码点计数。前端身份/结构校验不代替 Core 内容安全和流式隐藏标记清洗，后者仍未接通。

段头先给出身份，动作/情绪后续发布；turn_action 仍须在可见回复前完成准入。最终段校验与流结束校验继续执行，失败时保留已经交付的前缀并显式报错。

## 音频事件与二进制帧

| 类型 | 特有字段 | 语义 |
| --- | --- | --- |
| `output.audio_stream_start` | `encoding=pcm16le`、`sample_rate=32000`、`channels=1` | 首版固定格式，总时长未知；必须在第一帧前发送 |
| 二进制 audio chunk | 公共身份、`sample_offset`、PCM 字节 | 复用二进制帧容器的编解码约束，但明确为下行；携带 stream_id/seq 和完整段关联，不能只复制现有麦克风帧就视为下行已实现 |
| `output.audio_stream_end` | `status`、`reason`、`total_samples` | 表示不会再有新采样，不表示桌面已播完；EOF 后必须排空已接受缓冲 |

`sample_offset` 和 `total_samples` 按每声道采样帧计数。首帧 offset 为 0，之后必须连续；PCM 块长度必须为采样帧字节数的整数倍。传输可分包，禁止补发已播放采样、静默丢帧和把每包当独立 WAV 解码。

下行容器固定为 magic=AG99、version=1、frame_type=2、flags=0、12 字节头与 UTF-8 JSON metadata，长度字段为 little-endian；上行麦克风仍为 type=1。metadata 最多 64 KiB，单个 PCM 块最多 64 KiB。元数据同时包含公共身份、外部 turn_id 和固定音频格式；chunk seq 从 1 开始（0 留给 start）。整数和末采样位置必须在 JavaScript 安全整数范围内。实际消费端还须检查每条流的顺序、连续 offset、start/end 与旧 Turn；单包解析通过不代替状态校验。

Core 是唯一 TTS 调用方。新 MiniMax 双向实现公开音频块与格式，不经过完整文件物化。一个在途合成会话由一个 Turn 持有，跨 Turn 复用连接须在取消/排空确认后切换生成代次。

AstrBot Provider 入口为 `support_pcm_stream()` / `get_pcm_stream(text_source)`：输入字符串立即追加，输入 `None` 请求段 flush，输入迭代结束请求 session finish；输出 bytes 为 PCM 块，输出 `None` 为本次段 flush 确认。消费方必须在打断时关闭输出迭代器。此接口与旧文件/WAV `get_audio_stream()` 区分，不能把聊天流能力或旧 WAV 队列能力当作增量 PCM 准入。

Core 语音服务入口为 `synthesize_pcm_stream(context, event, PCMTextPart 输入流)`，返回带 start/audio/end、segment_index、sample_offset 和音频格式的 PCMStreamFrame。输入必须是预处理完成的增量，服务不代替 Core 内容校验或最终交付收口。当前已有此边界；桌面消费端已接入正式入站与时间线，但尚未连接 Core OLV 生产入口。

第一版不跨 Persona 段合并合成归属：segment_end 时发送 task_flush；确认已接受文本对应的 sentence_end 和 task_flushed、当前音频尾部归属确定后，才把下一段文本送入同一 Provider 会话。下一段在 Core 有界队列等待，不阻塞主模型继续生成，也不阻塞当前音频传输/播放。实现时先验证 Provider 的事件顺序，不能把 is_final 当整轮结束。

桌面建立音频 stream sink，取代新路径对 audio URL 和预先确定总时长的依赖。按实际消费采样数建立播放时钟；暂停/欠载期间时钟不虚走。口型、音量、输出设备及动作时间锚点使用这个 sink，同一段不能产生两个音频播放实例。

桌面播放边界已提供 `SpeechOutputRuntime.attachPcm()`：先 prepare，再串行 await append(sample_offset, pcm)，最后 finish(total_samples)。completed 仅在 EOF 且已接受音频排空后成功；dispose 冻结已消费前缀、停止节点并唤醒等待追加。复用现有输出图与 analyser；采样时钟只累计实际播放区间，欠载间隙不计入。缓冲最多四秒采样与 128 个音频节点，单块最多 64 KiB；调用者必须传播 await 背压，不能另建无界接收队列。此 API 已由正式桌面 socket/Store 消费，流序号、身份和旧 Turn 在入站校验，最终播放收口沿用现有时间线；现有冷启动设备预热仍为 350 ms，首版在首包时准备，提前准备仍待优化。

会话音频运行时现提供 `openPcmForTimelinePlayback(turn_id, segment_message_id)`，返回串行 append、finish 与排空 completed；沿用现有 PlaybackTimeline 的音频/口型 sink 及 Turn 打断，调用前必须完成正式播放段注册和流身份准入。PCM `started` 在 AudioContext 开始消费首批采样后通知，同进程 performance 时间由音频上下文估算，不等同于硬件实际发声时间。prepare、排队与设备预热不算起播。finish 的 failed 状态需提供 reason，已接受前缀先排空再以原原因失败；取消由时间线打断立即停播。此入口已在桌面组合层装配并由正式 socket 入站及流式段存储调用。真实 Live2D 口型和指定输出设备尚未验收。

正式 socket 入站与流式段存储现已连接：type=2 音频帧校验身份/seq/连续 sample_offset 后进入上述 PCM 时间线；首包创建播放器，空音频流明确 end 后记为 absent，不创建播放器。下一段首包等待上一段排空，音频播放不等 motion end；已终止/过期 Turn 的包明确记录并忽略。所有生产流关闭后允许 synth_finished 到达，播放完成回执仍等本地实际排空。打断/连接失败由原 Turn 清理播放，Store 将仍 open 的生产状态收为 cancelled；已经结束的生产状态不被播放取消改写。动作目前只准入 start/end，update 尚未实现；因此完整增量能力仍不登记、不启用，Core/Adapter 生产端也未接上。冷设备预热当前在首包创建播放器时发生，提前预热与真实首响耗时仍需后续测量。

## 动作事件

| 类型 | 特有字段 | 语义 |
| --- | --- | --- |
| `output.motion_stream_start` | 无 | 为该段打开动作输入，不将 pending 当作 absent/failed |
| `output.motion_stream_update` | `action_id`、`revision`、`mode`、`anchor`、`expires_at_sample`、`payload` | 通过校验的完整单条动作指令；mode 为 preview/actual，revision 在 action_id 内严格递增 |
| `output.motion_stream_end` | `status`、`reason` | 动作生产结束，可选动作失败不覆盖已成功交付的核心文本/音频 |

`payload` 使用现有可执行动作契约，由 ModelEngine 校验/编译，不直接写未经校验的 Live2D 参数。`profile_revision` 仍表示模型资源版本，不能替代这里的动作修订号。

`anchor` 明确为 `audio_sample` 或 `segment_now`。前者携带目标采样位置，后者表示当前姿态上的短预览；不能使用两个进程各自的 monotonic 时间进行比较。尚无音频时允许 segment_now 预览，后续实际动作到达后在同一参数控制权下融合。

桌面仅接受更高 revision。尚未执行部分可替换/追加；已执行部分不回放。超过 expires_at_sample、该段已关闭或 Turn 已终止的动作更新明确拒绝，并记录 expired/stale/terminal 原因。融合交接从当前实际姿态开始，不能重置整个动作造成跳变。

动作输出契约为连续闭合的小记录；收到一条完整指令就提交，不等 Provider EOF。聊天 Provider 在途请求不支持追加 prompt 时，使用用户输入预请求加后续有界意图请求，合并尚未发出的重复更新，不每个字重新请求。

## 结束、期限与背压

桌面正式 transport 当前串行 await 消息处理，接收队列（含在途消息）最多 128 条、16 MiB，同时限制单包；二进制直接以 ArrayBuffer 接收。溢出显式失败并关闭连接，不静默丢块。关闭连接取消在途 AbortSignal 并清空排队消息；异步消费者仍须在等待之后核对 signal/Turn，不能仅在回调入口核对一次。已握手、已校验且属于当前 Turn 的 interrupt 可以越过普通队列，先停止播放再取消在途处理，避免被 PCM 缓冲等待阻塞。未知或后续 Turn 打断不能越过其 turn_started。此机制是接收容量限制和协作式取消，不是浏览器 WebSocket 接收侧背压或服务端信用窗口；桌面音频分发已接通，Core/Adapter 生产端仍未连接。

1. 文本、音频和动作流独立结束。未返回动作不能提前登记为失败；音频起播不等待动作终态。
2. 移除把 0.75 秒同时作为首响等待和动作任务生存期限的设计。动作生产期限使用配置并受 Turn 剩余预算约束；音频不等待动作。到期需记录 context/gate/provider/parse 等实际阶段，不能只留下 motion_state=failed。
3. 音频已播放完但动作仍在合法窗口时，Turn 保持结算态；窗口关闭后取消尚未完成的动作并发出明确终态，不无限等待，不补播过期动作。
4. 所有生产流关闭并排空后才发送 control.synth_finished。桌面所有已接受播放任务结算后发送 playback_finished。TurnCoordinator 最后发送 turn_finished，不能在文本或音频单支路结束时清理全部动作注册表。
5. 用户打断、断线或总期限到达时，由 Turn 所有者终止三条流与本地播放。已接受前缀保留为不完整结果；旧生成代次不得污染新 Turn。
6. 各队列必须同时限制条数和累计字节/采样量，单个超大块也计入容量。传输满时通过有界 await 背压；停止或失败必须能唤醒排队任务。首版具体容量随真实播放负载验证后冻结，不使用无界容器。

## 观测与第一批实测

- 动作 Provider 请求必须记录 motion_request_id、core_turn_id、persona_result_id、segment_index；首块、流结束和合法结果共享请求 ID。deadline 日志注明实际阶段，区分没首块、已有增量但未闭合、解析拒绝和交付过期。
- 文本首增量、TTS 首块、Adapter 首帧、桌面首采样及动作首指令分别记录。跨进程记录 epoch，进程内耗时用本进程 monotonic；仅在同一时钟域相减。
- 2026-10-16 使用当前配置的 speech-2.8-turbo 与当前音色直连双向接口：连接约 578 ms，任务就绪约 610 ms，首 MP3 块约 797 ms（发送首批文本后约 187 ms），首块早于第二批文本和 finish；flush、cancel、finish 均收到确认。
- 独立的 PCM 编码验证通过：32000 Hz 单声道 format=pcm，首块 2048 字节，文本发出后约 234 ms 收到；块非 RIFF，采样边界对齐。共收到 78020 字节，flush/finish 正常。PCM 采样解释和实际播放还需在真实桌面验收，不能把这次网络边界检查当作已听到声音。
- 以上均为短文本单次实测，无 ASR、Persona、Adapter 下行和 Electron 播放，不代表首响 p50/p95，不建立硬编码超时目标。未改配置或重启应用。

官方接口依据：[MiniMax 双向流式语音合成](https://platform.minimax.cn/docs/api-reference/speech-t2a-websocket-bidi)。
