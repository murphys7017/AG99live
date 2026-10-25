# AG99live Adapter

AG99 插件 `astrbot_plugin_ag99live_adapter` 将 AG99 的对话、TTS 和动作结果接入 AG99live 桌面端。动作可由 Persona Effect 或独立 Provider 生成。当前版本为 **1.1.0**，协议版本以 `protocol/schema_manifest.json` 为准。本版本与 AG99live 桌面端 `0.1.0` 安装包配套。

## 职责

- 接收文本、流式麦克风、图片和平台事件输入，并提交到 AG99 的正常对话流程。
- 收集一条逻辑消息的文本、TTS、动作和媒体，提交原子 `output.segment` 消息，其 Payload Schema 为 `output.segment.v6`。
- 校验 `ag99live.motion`，提供模型扫描、profile、动作资源和媒体的本机服务。
- 管理 Turn、段、取消、Motion Lab 记录、可选 performance curve 与连接清理。

它不将语义动作转换为 Live2D 参数，也不创建前端播放时钟或默认动作。

## 运行接口

默认服务仅绑定 `127.0.0.1`：

| 服务 | 默认端口 | 作用 |
| --- | ---: | --- |
| WebSocket | `12396` | 输入、输出、控制、模型与系统消息。 |
| HTTP | `12397` | 已扫描模型、缓存音频、图片和允许的静态资源。 |

端口由 AstrBot 平台启动配置的 `port` 和 `http_port` 设置。其他根配置包括 `speaker_name` 和 `auto_start_mic`，属于启动级设置。Adapter 运行设置统一在 AG99live Web 控制台编辑；AstrBot 插件配置文件由 Adapter 用作持久化，不再提供第二套插件设置表单。桌面本机设置由桌面设置窗口管理，也可从 Web 控制台转发修改。

### 身份字段

AG99 的平台配置和插件的 `general` 配置使用的是两套身份，不能混为一个“用户 ID”：

- `olv_pet_adapter` 是固定的适配器类型，不是桌宠名称，也不是用户 ID。
- AG99 平台配置中的 `id`（界面可能标成“机器人名称”）是具体的**桌宠实例 ID**，例如 `aki`。它用于区分连接实例、作为平台路由键，并作为入站消息的 `self_id`；多个桌宠实例必须使用不同值。
- `general.client_uid` 是桌面端消息客户端的**会话/发送者 ID**，例如 `desktop-client`。它不是桌宠实例 ID，也不是 AG99 WebUI 登录用户账号。它属于 Adapter 运行设置，所有 Adapter 实例共用同一个值；当前不能为每个桌宠实例分别设置。
- `general.client_nickname` 是桌面端消息在 AG99 中显示的发送者名称。
- 平台配置的 `speaker_name` 是桌宠回复侧的说话人名称，不承担实例寻址或用户身份作用。

当前适配器实际读取的平台字段是 `id`、`enable`、`port`、`http_port`、`speaker_name` 和 `auto_start_mic`；旧配置中若仍看到 `host`、`debug_port` 或 `conf_name`，它们不会改变当前运行时行为。

## 动作路径

```text
AG99 Persona
  -> ag99live.motion
  -> Adapter 严格校验
  -> engine.motion_intent.v4
  -> output.segment（schema: output.segment.v6）
  -> 前端 ModelEngine
  -> engine.parameter_plan.v3 或受控资源执行
```

动作生成依赖 AG99 Persona 扩展或兼容的 Persona 生命周期能力；官方 Core 不支持这些扩展时，Adapter 仍可转发对话和 TTS，但不生成动作。

动作输入选择 `axis_levels`、稀疏 `motion_steps` 或 `motion_resource_id` 之一。未知轴、非法等级、空 step、形态冲突和无效资源会明确失败；Adapter 不补轴、不改名、不生成 neutral pose。

### 动作生成模式

`independent_motion.enabled` 默认关闭。关闭时由 Persona Effect 为 Persona 回复段生成动作。开启后停用 Persona Effect，改由单独选择的聊天 Provider 为每个非空 `segments[].speech` 分别生成动作，并绑定到同索引的 TTS/输出段。独立动作没有整回复生成模式；旧配置中的 `per_speech_segment` 会在启动时清除，不再决定动作粒度。

`parallel` 控制非流式 Persona 结果中的逐段动作请求是并发还是串行；并发数由 `max_concurrency` 限制。独立动作 Provider 使用 `text_chat_stream()`。OLV Persona 段流开启且 Core 能力检查通过时，每个 `segment_start` 会启动对应动作请求，与后续 speech 生成及 Core 管理的 TTS 合成重叠；每段使用同一绝对时限约束上下文准备和 Provider 请求。Provider 不支持聊天流、请求超时或失败时，该段跳过动作并保留失败原因，核心文本/TTS 继续。TTS 身份到达后 Adapter 按 `turn_id`、`persona_result_id` 和分段索引绑定动作；支持段级物料化时，Core 最多并发准备 2 段语音，每段只等待对应动作 Future，按序提交并 flush 原子 `output.segment`，首段不等待其余段的动作。Persona 段流未启用或能力检查未通过时，不请求增量动作，继续使用 Core 的普通 Persona 输出流程。段索引决定对应关系，Provider 的返回先后不决定播放顺序。

`history_turns` 控制附带的最近纯文本对话轮数（默认 6，范围 0–20）。动作 Provider 不接收图片、截图上下文说明、工具消息或 memory slot；主回复模型的图片输入不受影响。每段动作输入只包含当前用户文本和当前 `speech`、`actions`、`tendency`；历史仅通过上述有界的纯文本对话轮次提供，不额外检索或注入记忆。Prompt 保留合法轴/等级和资源约束。另保留最多 2 个相关示例和最近 3 个执行动作，全部投影为当前输出契约的 input/output 结构；移除运行标识，跳过不兼容或超过 2400 字符的单条参考，不截断 JSON。当前 actions 优先于参考。`max_concurrency` 默认 4、最大 8；`segment_timeout_seconds` 默认 5 秒、最大 60 秒，0 表示不限制非流式单段请求。完整 Core 汇合仍受 30 秒上限约束。详细 WIRING 过程日志使用 DEBUG，分段生成摘要和最终投递保留 INFO，异常保留 WARN/ERROR。

### NeuroBrain 状态上下文

当同一 AstrBot 进程加载并启用 `astrbot_plugin_neurobrain` 时，独立动作路径直接通过无参数 `get_state()` 读取当前完整快照。读取不等待本轮情绪输入处理完成，不触发推理；模型在独立线程中持续演化。动作 prompt 中仅包含经过范围校验的当前 `emotion` 和 `behavior`。最近一次输入刺激 `last_tendency` 与内部步数 `step` 只保留在 NeuroBrain 快照和诊断侧，不作为动作模型的决策输入。模型未就绪时省略状态。AG99live 不直接连接 NeuroBrain WebSocket，也不提交刺激。

NeuroBrain 状态只是动作选择的辅助信号，不是动作命令；动作结果仍必须通过现有校验、`engine.motion_intent.v4` 和 `output.segment.v6` 发送链路。该接入不增加协议字段、不改变段身份、不改变播放时钟。

### OLV 后台被动动作实验链路

`passive_behavior.enabled` 默认关闭。开启后，OLV 桌宠 Adapter 自己维护一个异步后台任务；只有桌面端在线、没有活动 Turn 或正在采集/转写的语音输入、请求间隔和冷却条件都满足时，才读取 NeuroBrain 只读 API 的当前快照并调用所选 AstrBot Provider。读取无需状态键或人格 ID。该链路不读取或写入聊天历史，不等待 Persona，也不参与普通回复、TTS 或用户消息处理。

后台 Provider 使用 AstrBot 的 `text_chat_stream()`。每次只接收一个完整动作决策，校验后立即通过 `output.idle_motion` 发送，`turn_id=null`，不创建、占用或结束任何对话 Turn，也不发合成完成信号。payload 仅包含现有 `engine.motion_intent.v4` 数据 `motion` 和过期时间 `expires_at_epoch_ms`。过期、断线或前台忙碌时丢弃，不进入对话播放队列。

待机动作只进入 WebSDK 参数混合器的低优先级 `idle_motion` 层，不调用正式动作计划的替换入口，不改变前台状态、聊天历史、动作实验室或 performance curve 状态。前台动作、视线和口型优先；切换来源时保留当前参数偏移和速度。默认动作时长 4 秒，最短 3 秒，进入和退出各约占 35%，通过逐帧权重混合和现有参数响应限制缓慢接入、平滑释放。

PTT 采集开始、VAD 检测到开口以及新输入提交时会打断被动播放并取消在途生成；语音采集和转写期间暂停新的被动请求。

配置项包括 `provider_id`、`request_interval_ms`、`cooldown_ms`、`result_ttl_ms` 和 `timeout_seconds`。启用后请为 Provider 选择支持 AstrBot 流式输出的聊天模型；没有流式实现的 Provider 会记录失败并跳过，不会退回非流式请求。

Persona `segments[].speech` 是 TTS 文本分段，不是协议中的 speech cues。协议 slot 仍可承载可选 speech cues，但当前 Adapter 输出 `speech: absent`。详见[动作生成与 Persona 分段关联](../docs/01-架构与结构/07-动作生成与Persona分段关联.md)。

## 音频输入和取消

麦克风采集由 `input.audio_stream_start`、二进制 PCM16LE chunk 和 `input.audio_stream_end` 组成。后端用 `stream_id` 汇总、严格检查顺序，并根据 PTT 或 VAD 建立正式 Turn。持续收音的 `capture_turn_id` 只标识采集根，每段 VAD 语音使用 `<capture_turn_id>:vad:<n>` 子 Turn。

可选 `fast_asr` 使用 sherpa-onnx 在 Adapter 内对 PTT 和 VAD 音频做本地增量识别。在 AG99live Web 控制台设置模型目录与推理后端，并先在 AstrBot 实际运行的 Python 环境安装 `sherpa-onnx` 和 `sherpa-onnx-bin`。原有 AstrBot STT 不参与普通语音输入；只有 Core 判定需要任务交接时，才使用同一 Turn 缓存的 PCM 复核，并将修订文本用于任务规划。音频复核缓存最多保留 8 段、每段 12 MiB，120 秒过期。此功能依赖 Core 提供 `_ag99live_handoff_asr_review` 回调。

`control.interrupt` 只停止目标 Turn。连接断开时，Adapter 请求停止全部在飞 AG99 event，再独立清理 Turn、段、曲线请求和身份映射；晚到输出不会重新进入播放。

## AG99 Web 控制台

启用插件后，在 AG99 WebUI 的插件详情页打开 **AG99live 控制台**，可以编辑 Adapter 配置、Live2D 语义轴 Profile 和动作调参样例，并管理当前 Adapter 的对话历史。页面通过 AG99 插件视图 bridge 访问受认证的插件 API，不单独启动 Web 服务。

**对话历史** 支持只读查看、新建、显式载入和确认删除。只读查看不会切换当前会话；新建或载入会话会改变桌宠后续聊天的上下文。API 检查会话所属的 Adapter 平台及 Client UID，不允许跨实例操作；新建的空会话也会保留在列表中。此功能直接复用 AG99 会话服务，不依赖桌面 WebSocket 在线，也不占用第二条连接。页面按需读取历史，会话和消息每页最多渲染 100 项。

麦克风、全局快捷键和 Spout/ESP32 等本机功能仍由 AG99live 桌面运行时持有，Web 页面经桌面设置 broker 读写，不把本机配置存入 Adapter。Electron 还支持从 Web 修改鼠标凝视参数与托盘使用的 WebUI 基址；native runtime 以实际支持的设置项为准。实时动作预览仍保留本机入口；旧历史窗口保留到 Web 历史现场验收完成，不会自动同步 Web 会话选择，历史管理请优先使用 Web。

Electron 托盘和桌宠右键的 **打开 Web 控制面板** 会在默认浏览器打开本插件页面。默认 WebUI 基址为 `http://127.0.0.1:6185/`；使用其他地址或反向代理时，在桌面 **本机工具 > 本机设置** 或已连接的 Web 本机配置中设置。登录继续由 AG99 管理。

## 开发

在仓库根目录执行：

```powershell
python -m pip install -r astrbot_plugin_ag99live_adapter/requirements.txt
python scripts/check_protocol_schema_manifest.py
```

如果只拿到了已经复制到 AG99 插件目录的本目录，则在该插件目录执行：

```powershell
python -m pip install -r requirements.txt
```

协议检查只比较 schema manifest 与生成的 TypeScript 文件。完整验证仍需在真实 AG99、TTS、Electron 和 Live2D 环境中检查段顺序、音频、口型、动作和完成回执。

完整源码仓库中的深入说明见[文档中心](https://github.com/murphys7017/AG99live/blob/main/docs/README.md)。

## 发布版安装

桌面端安装包从 [AG99live GitHub Releases](https://github.com/murphys7017/AG99live/releases) 获取。Adapter 不随桌面安装包嵌入，需要将本目录复制到 AG99 插件目录，并在 AG99 使用的 Python 环境中执行：

```powershell
python -m pip install -r astrbot_plugin_ag99live_adapter/requirements.txt
```

### 普通模式的后到动作

普通文件音频已就绪、同段动作仍在生成时，`output.segment.v6` 使用 `motion.state=pending` 先交付文本和完整音频；后续 `output.segment_motion` 使用相同 turn_id/message_id 交付一次终态动作槽位。它不复用 PCM 增量事件。后端在动作结果发送完成后才关闭 synth；断连/取消回收任务。桌面端将播放中的后到动作挂到原音频时间线，音频已经结束的过期动作显式失败，不重播声音。纯动作和音频合成失败继续按既有完整交付处理。两端须匹配 v6 manifest，旧桌面会在握手拒绝，升级后再重连。


## 返回电脑后的主动互动

在 AG99live Web 控制台的“返回电脑互动”中启用 `desktop_return.enabled`（默认关闭）。需加载本轮配套的 Electron 主进程、预加载和前端，再重载适配器。复用已有 Personal Policy、Persona、TTS 与 Live2D 动作输出，不另选模型，不强制每次开口。

- 锁屏/休眠默认至少60秒；解锁或唤醒后，必须恢复实际输入操作。普通长时间无操作默认300秒，其恢复仅表述为“恢复操作”，不推断用户身体离开。
- 恢复候选默认确认3秒，期间需再次出现输入；仅自动唤醒或碰一下鼠标不会直接欢迎。15秒未确认就丢弃该候选。
- 同次返回只提交一次机会；独立机会冷却默认900秒，事实有效期仅30秒。现有安静时段、忙碌、预算及主动回复冷却继续生效，Policy仍可选择不说话或延后，过期不补播。
- 用户已在说话/对话时丢弃本次机会；提交后用户先开口、再次进入无操作状态、关闭来源或断连，会撤销旧事实及相关策略/表达工作。本次欢迎不自动追问用户为何未回应。
- 仅在启用且会话准入通过时读取系统空闲时长与锁屏/休眠状态，不读取按键内容、不截图、不分析桌面。检测状态在Electron主进程；启动/重连/配置变更先建立基线，旧返回事件不补发。

日志查看 `desktop_return.state`（active/inactive/confirming/unknown）、`candidate` 的准入原因及 `submitted` 的入队结果，再检查 Personal Policy 的 Gate/表达日志。数学桌面变化观察是独立来源；返回互动不等待它的60秒对话后观察窗口，但会避开活动对话并在新输入到来时撤销。

设计与真实验收步骤见 `docs/desktop-return-plan.md`。当前只有“策略决定是否通过普通语音/动作链路表达”；尚未新增独立的“只挥手、不说话”策略动作。

## 桌面变化观察

在 AG99live Web 控制台的“桌面变化观察”中启用 `desktop_observation.enabled`。默认关闭；间隔默认30秒，变化事件有效期60秒。画面比较完全使用数学方法，不需要配置视觉模型，也不调用0.8B模型。

桌面观察服从对话优先级：用户文字输入、PTT或VAD实际语音、正在处理的轮次和播放期间暂停截图与比较。常驻麦克风的静音收音不算对话。用户输入及AI播放完成后，等待 `conversation_quiet_seconds`（默认60秒，可配置0～3600秒）再观察；设为0仍会避开活动轮次。启动/重连也先等待；恢复时首帧仅建立新基准，不比较对话前的旧截图。

新输入会撤销之前采样的桌面事件：Intake/Inbox丢弃失效事实，正在等待或执行的策略与表达任务会被取消，避免对话后补播旧事件。检测在截图前、采样后、数学比对后再次校验活动窗口；AI播放完成会刷新基准版本，但不撤销正在确认播放完成的自身动作。

仅关注大范围画面变化：将192×108的RGB画面分为144个12×12区域，分别计算结构相似度（SSIM）及平均颜色差。区域平均SSIM低于0.85且平均颜色差达到12/255时，才计入变化面积。变化区域占比达到 `changed_area_threshold_percent`（默认15%，可配置）便提交变化事实；这是分块面积估计，不是精确的变化像素比例。现有用户阈值保留，新算法需重新实测校准。小通知、小弹窗、眨眼和轻微动作允许忽略；不识别文字、不分析桌面内容、不遮罩桌宠。Windows通知另作事件源，本功能不接入。

需要完整重启 AstrBot 同时加载新版适配器和本体可撤销Sensor接口，不能只热重载插件。本轮不改前端，已有配套截图协议及超时恢复的桌面端无需重新构建。仅 Electron 声明采集能力后才请求截图，首帧建立基准不发事件。图片不落盘、不写入聊天历史；无大范围变化不提交事件。功能关闭、断连或卸载后停止比较。

截图超时会释放逻辑请求槽位，后台暂停自动重试，防止堆积原生 IPC；用户主动截图仍可重新尝试。前台成功或原生迟到完成后允许重新采样，迟到图片不复用。底层 IPC 没有强制取消接口，不宣称已取消仍未完成的系统采集。

有效期从本机截图请求开始计算，覆盖采样、数学比对和提交等待，旧画面过期不发事件。已入队事件继续由本体已有 TTL/策略管理，关闭采样不撤回历史事实。

变化事实通过已有 RuntimeObservationSensor 接入 Personal Policy；是否说话由本体决定，策略模型仍在本体设置（可选择 MiniMax 3.1）。安静时段、冷却及预算继续生效，检测到变化不保证立即说话。真实识别准确率及主动语音/Live2D效果须配套加载后验收。

设计与验收见仓库 `docs/desktop-observation-plan.md`。
