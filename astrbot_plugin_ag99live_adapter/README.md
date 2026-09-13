# astrbot_plugin_ag99live_adapter

AG99live 的 AstrBot 插件侧实现。AG99live 是 AstrBot 的桌面身体，本目录负责把 AstrBot 的人格回应
连接到桌宠式伴侣的 Live2D 表现：协议桥接、Turn 生命周期、媒体处理、Live2D 扫描，以及把 Persona
回复产生的文本、TTS 和动作意图聚合为前端可消费的原子输出段。

AstrBot 仍然拥有核心人格、记忆和对话决策；AG99live 不建立平行人格，只负责让这些回应通过桌面上的
身体、声音、视线、动作和表情与用户相处。直播弹幕是可接入的消息来源，不是本项目的产品身份。

## 核心职责

- 接收前端 `input.*` 消息并转为 AstrBot 事件。
- 发送 `output.segment.v5 / control.* / system.*` 消息回前端；正式回复动作只存在于原子段的 motion slot，语音 cue 只存在于 speech slot。
- 管理 turn 生命周期，保证文本/语音/动作消息在同一轮次可追踪。
- 扫描 Live2D 资源并产出结构化能力信息。
- 生成并下发动作用载荷；统一走 AstrBot 交互中间件主链路，由 `ag99live.motion` Persona Effect 产出动作并通过 `client_objects` 下发。

## 当前路线说明

- 后端当前主职责是把 `ag99live.motion` 的九级 `axis_levels` 严格归一化为 `engine.motion_intent.v4`，并通过 middleware-first 链路稳定送到前端。
- 前端 `ModelEngine` 负责把 intent 编译为 `engine.parameter_plan.v3`。
- 说话时的 plan 级补偿由前端 compile 侧 `SpeechPoseStage` 承接。
- 扫描器下发 `ag99.voice_following_profile.v3`，只描述语义轴、有效幅度比例和跟随延迟；最终参数绑定、范围和动力学统一由 semantic axis profile 负责。
- 旧 `voice_following_profile.v1/v2` 和 `speech_pose_cycle` 不属于兼容协议，前端入站会显式拒绝。
- 连续多段之间的惯性、衰减、残留、soft handoff 和层间混合由前端 AG99 Live2D runtime 的 `ActiveParameterRuntime`、`ActiveParameterMixer` 和 `ParameterPresentation` 承接，而不是放回后端动作生成链路。

## 当前部署边界

- 桌宠 WebSocket 与静态资源 HTTP 固定绑定 `127.0.0.1`，用于 AstrBot 与 Electron
  在同一台电脑上的部署。
- 当前协议没有远程客户端认证、授权、TLS 和跨主机媒体 URL 保护，因此不能把 `host`
  改为局域网或公网地址来部署远程 AstrBot。
- 保留的 Remote Operator 配置与实现已冻结，计划迁移到其他项目；它不参与当前桌宠交互链路。
- 后续远程 AstrBot 部署必须先定义 authenticated WSS/HTTPS、客户端身份、媒体授权和断线恢复，
  再同步修改 transport、URL 构造、配置 schema 和前端连接设置。

## 目录结构

```text
astrbot_plugin_ag99live_adapter/
├─ protocol/             # 协议常量、模型、解析与构造
├─ transport/            # WebSocket、静态资源与路由
├─ runtime/              # Turn、输出段、观察记录、可选曲线与 session/chat 状态
├─ services/             # 媒体、消息、语音服务
├─ motion/               # 动作意图生成与输出清洗
├─ middleware/           # interaction 动作贡献（含冻结的远程执行器遗留代码）
├─ live2d/               # 扫描、缓存与分析
├─ tests/                # 单元测试
├─ live2ds/              # 模型资源
├─ main.py               # AstrBot 插件入口
├─ platform_adapter.py   # 平台适配层
├─ platform_event.py     # 平台事件封装
└─ _conf_schema.json     # 插件配置项定义
```

## 动作链路

### 统一主路径（middleware-first）

- 主模型在同一次 Persona 回复中生成 `spoken_reply` 与唯一 `ag99live.motion` effect；动作不由第二个
  对话模型或 TTS 阶段重新推断。
- 交互中间件在 prompt contributor 中注入动作能力/运行态上下文，并注册 `ag99live.motion` Persona Effect；该 effect 只对具备 AG99live motion runtime 的直接前端会话开放，不进入其他平台回灌事件的 Persona 契约。result contributor 从 `view.effect_calls` 消费该 effect 并返回 `client_objects`。
- `ag99live.motion` 只属于 Persona 输出契约，不进入 Router；Router 不注册该 effect，也不把它当作 Agent Tool。
- 后端从 `platform_extras` / `client_objects` 中读取动作载荷，并与文本、音频一起广播到前端。
- 任何额外动作来源都必须回到同一条 `engine.motion_*` 协议链路和同一 segment identity，不能绕过 ModelEngine 或 PlaybackTimeline。

### 官方 `<@anim>` 兼容路径

`<@anim {...}>` 不是 AG99live 的第二条主链路，也不是 `ag99live.motion` 失败后的兜底。它只用于兼容缺少 Interaction Runtime 和 Persona Effect 注入能力的官方 AstrBot：

- 插件入口检测 Interaction contributor 注册接口；可用时保持增强版 middleware-first 链路。
- 官方 Core 不具备这些接口时，`on_llm_request` 注入同一套语义轴、参考样本和 V4 输出约束，并要求把动作包装进 `<@anim {"mode":"inline","intent":...}>`。
- 增强版 Core 的契约要求在同一逻辑消息的全部物理 `MessageChain` 成功派发后调用
  `complete_visible_message(message_id=...)`；Adapter 立即发送该原子段。官方 Core 不提供这项消息级
  生命周期，默认不启用分段回复，并继续只以 `complete_visible_turn()` 关闭整轮输出队列。
- 标签外层只接受 `mode="inline"` 与 `intent`；裸 intent、`motion_payload`、`plan` 和其他历史包装字段会被拒绝。
- 如果 `<@anim>` 内部 JSON、schema 或 v4 payload 无效，后端只记录拒绝原因，不生成替代动作。
- 官方 Core 没有 `TTSState`、`tts_request_id` 或 TTS 失败通知。Adapter 只把最终 `Record` 当作音频成功事实；没有 `Record` 时只能声明无音频，不能伪造 `failed`。可选 performance curve 在此模式不启动。
- 官方兼容模式不具备增强版的 Prompt/Result contributor 生命周期；因此不启用仅依赖该生命周期的扩展能力。

### 动作效果输出

- 当前 Persona Effect 主动作载荷为 `engine.motion_intent.v4`，前端 `ModelEngine` 根据 `semantic_axis_profile.level_anchors` 把 `axis_levels` 转换为轴值，再编译为 `engine.parameter_plan.v3`。
- `axis_levels` 只能使用 `-4..4` 整数；省略表示本轮不控制该轴，`0` 表示明确回到中性。混入 `axes`、非法等级或空等级对象会直接拒绝，不会回退到 v3。
- `motion_steps` 是稀疏序列：每步只写新声明或需要改变的轴；轴首次声明前不受本序列控制，首次声明后省略表示保持上一目标，显式 `0` 才表示回到中性。
- 普通 Live2D 主要姿态默认从三级开始；四级由每轴独立 `extreme_range` 定义，用于短时夸张表演。内置七类 v4 示例和当前 profile revision 的人工筛选样本会注入 capability。
- 可选资源使用 `expression_resource_id` 或 `motion_resource_id`，一次最多选择一个。expression 只与无参数冲突的计划叠加；motion 作为完整动作替代参数计划，但仍共享当前 segment 的统一 motion sink。
- 正式动作输入唯一使用 `engine.motion_intent.v4`。手动预览保存并重放第一阶段的 `CompiledSemanticMotion`，直接进入模型参数编译，不经过 WebSocket 动作协议。
- 自动动作链路不允许 LLM 输出 `choice`、`motion_id`、`engine.catalog_motion.v1` 直接 payload、motion3、exp3 或旧播放文件引用。
- 中间件 prompt 只暴露 profile 中的 `primary/hint` axes，禁止输出 `derived/runtime/ambient/debug` axes。

## 与前端协同的关键点

- 每条交互消息都带 `turn_id`，前后端只按这一个轮次 ID 做会话协调。
- 每个 assistant segment 由非空 `turn_id + message_id + sequence` 标识；Platform Event 在逻辑消息首次进入 Adapter 时分配连续 `sequence`，Adapter 只按连续序号发送已 finalized 的段，避免异步物理投递改变播放顺序。增强版 Core 必须只在该逻辑消息的全部物理 `MessageChain` 均派发成功后调用 `event.complete_visible_message(message_id=...)`；Adapter 随即发送可连续释放的 `output.segment.v5`，不等待同一 turn 的后续 segment。
- 隐藏动作传输标记在回复进入 TTS 前的输出规范化阶段清洗；原文只供官方 `<@anim>` 兼容解析。增强版 Core 只读监听 AstrBot TTS 生成状态并可下发 `audio.state=failed`；官方 Core 只依据最终 `Record` 投影音频成功，不模拟不存在的生命周期。
- 正式动作位于 `output.segment.motion.payload`；前端原子提交完整段后，由 ModelEngine 把 intent 编译为 `engine.parameter_plan.v3`。
- `system.server_info` 携带完整 schema manifest；前端只有在 manifest 与本地契约完全一致后才处理后续消息。
- `system.model_sync` 使用 `live2d_scan.v3`，只下发前端运行需要的模型资源摘要、参数扫描、包含原始 SDK locator 的 resource constraints、`parameter_action_library`、`semantic_axis_profile` 和 `voice_following_profile`。后端分析中间产物不跨 WebSocket 复制。
- `runtime_cache_errors` 只作为 `system.model_sync.payload` 根部的独立运行诊断下发，不复制进 `model_info`。
- `system.semantic_axis_profile_saved` / `system.semantic_axis_profile_save_failed` 用于 Profile Editor 保存结果确认，不再依赖 `system.model_sync` 推断保存成败。
- 一个 user input 对应一个 turn，但一个 turn 内可能输出多个 assistant segment。
- `control.synth_finished` 表示该 turn 的原子输出队列关闭；到达前所有 segment 都必须已经由 `complete_visible_message()` 发送，到达后不接受新段或 late slot patch。若 Core 在未完成的 segment 仍存在时关闭 turn，Adapter 发送 `control.error` 并终止该 turn，避免将不完整输出当作完成。
- `ag99live_motion_schedule` 已表明本段应生成动作、但 effect 缺失或非法时，Adapter 必须下发
  `motion.state=failed`；只有明确未安排语义动作时才使用 `motion.state=absent`。
- 前端在 `synth_finished` 已到、所有 segment 槽位 settled 且同一 Turn 不存在开放的 required
  execution Timeline 后回传 `control.playback_finished`；后端收到后再发 `control.turn_finished`。
- `output.segment.audio.url` 指向插件侧 HTTP 静态资源，通常是 `/cache/audio/*.wav`；有 TTS 文件但前端无声时，应先验证该 URL 在配置的 `host / http_port` 上是否可达。
- 麦克风输入按采集会话组织：`input.audio_stream_start`、WebSocket binary PCM16LE chunk 与 `input.audio_stream_end` 共享一个采集根 `turn_id` 和 `stream_id`，后端 STT ingress 按 `stream_id` 汇总音频，不会把不同采集会话混到全局缓冲。PTT 采集直接以该根 ID 作为对话轮次；常开收音的每个 VAD 语音段由后端派生为 `<capture_turn_id>:vad:<n>` 子轮次，再作为正式对话、输出段和播放会话的 `turn_id`。用户再次开口时，协调器只中断同一采集会话仍在飞的子轮次，采集本身持续运行。
- 若前端检测到发送积压，会在 `input.audio_stream_end` 中带上 `dropped: true`，后端直接丢弃该段转写。
- 切换麦克风设备时，前端会先正常结束旧输入段，再启动新输入段；收到 `control.interrupt` 时，前端只中断该信封 `turn_id` 已释放的 segment，并由后端停止同一 Turn 的 AstrBot event；已取消 event 的晚到输出不会重新进入播放链路。
- WebSocket 断开时，Adapter 先给全部在飞 event 写入 `agent_stop_requested` 并调用
  `stop_event()`，再清理 Turn、Segment、曲线请求和 ID 映射；`OLVPetPlatformEvent`
  在发送边界丢弃被停止 Turn 的迟到输出。
- Windows / Electron 前端现在优先使用主进程 DirectShow/ffmpeg 原生麦克风枚举与采集；原生路径直接采集 `s16le`，渲染进程通过二进制音频帧发送给插件侧。
- 非流式 JSON 数组音频协议已删除；麦克风输入只接受当前流式协议。
- 按键说话模式会以 `reason="ptt_release"` 结束本段录音；对插件侧来说它仍是一段普通麦克风输入。

## 冻结的远程执行器

仓库中仍保留 Remote Operator 的配置与实现，以便后续迁移到其他项目；AG99live 当前不再将其作为产品能力，也不在此继续设计、测试或扩展。历史边界与迁移提示见 [远程执行器接入设计](../docs/02-设计文档/07-远程执行器接入设计.md)。

当前结构注意点：

- 文档语义要求 `synth_finished` 是 turn 级输出队列关闭信号。
- 如果同一 turn 内会多次输出 assistant segment，后端必须确保最后一个 segment 之后才发送 `synth_finished`。
- 这不是单条音频生成完成信号，也不是整轮完成信号。

## 关键配置

- `general`：桌面端身份与会话缓存。
- `live2d_input`：模型选择和图片输入冷却。
- `performance_curve`：可选表演曲线的开关与专用 Provider。
- `vad`：Silero VAD 的断句阈值和连续帧参数。
- `remote_operator`：冻结的迁移遗留配置；当前 AG99live 不维护或扩展此项。

配置结构已按职责重组；旧的平级配置键不会再被读取。开发阶段请直接按当前 Schema 重新生成或编辑插件配置，不保留旧路径兼容。

当前 Persona Effect 的参考策略：

- 自动动作链路不再把旧 motion/exp3 reference templates 或 `engine.catalog_motion.v1` 直接 payload 作为模型可选项注入。
- 动作 Prompt 使用当前 `SemanticAxisProfile` 轴说明、动作指令、用户手调样本形成的风格偏好和姿态参考候选。
- fallback pose 候选只作为 Prompt 姿态参考，不修复非法输入、不替换有效等级，也不会在输入为空时生成默认 neutral pose。

## 开发与验证

安装依赖：

```powershell
pip install -r astrbot_plugin_ag99live_adapter/requirements.txt
```

最小静态检查：

```powershell
python scripts/check_protocol_schema_manifest.py
```

该检查只验证协议版本清单的一致性。真实正确性仍需要在 AstrBot + TTS + Electron +
Live2D 环境中观察原子段、音频、口型、动作和完成回执；不以历史测试数量替代运行证据。
