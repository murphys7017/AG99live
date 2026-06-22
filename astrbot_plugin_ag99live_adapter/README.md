# astrbot_plugin_ag99live_adapter

AG99live V2 的 AstrBot 插件侧实现。该目录负责协议桥接、turn 生命周期、媒体处理、Live2D 扫描，以及把中间件/主回复产生的动作载荷广播给前端。

## 核心职责

- 接收前端 `input.*` 消息并转为 AstrBot 事件。
- 发送 `output.* / control.* / system.* / engine.*` 消息回前端。
- 管理 turn 生命周期，保证文本/语音/动作消息在同一轮次可追踪。
- 扫描 Live2D 资源并产出结构化能力信息。
- 生成并下发动作用载荷；默认走 AstrBot 交互中间件主链路，由 `ag99live.motion` Persona Effect 产出动作并通过 `client_objects` 下发；`inline_first` 内联动作链路仅作为显式兼容路径保留。
- 注入远程执行器能力，并把电脑/桌面/软件操作类请求委托给配置的 Codex app-server / Computer Use。

## 当前路线说明

- 后端当前主职责是产出结构化动作意图 `engine.motion_intent.v3`，并通过 middleware-first 链路稳定送到前端。
- 前端 `ModelEngine` 负责把 intent 编译为 `engine.parameter_plan.v2`。
- 说话时的 plan 级补偿由前端 compile 侧 `SpeechPoseStage` 承接。
- 连续多段之间的惯性、衰减、残留、soft handoff 和层间混合由前端 Live2D runtime 侧 `ParameterPresentationLayer` 承接，而不是放回后端动作生成链路。

## 目录结构

```text
astrbot_plugin_ag99live_adapter/
├─ protocol/             # 协议常量、模型、解析与构造
├─ transport/            # WebSocket、静态资源与路由
├─ runtime/              # runtime state、turn 协调、session/chat 状态
├─ services/             # 媒体、消息、语音服务
├─ motion/               # 动作意图生成与输出清洗
├─ middleware/           # interaction 动作贡献、远程执行器 prompt/result 贡献
├─ live2d/               # 扫描、缓存与分析
├─ tests/                # 单元测试
├─ live2ds/              # 模型资源
├─ main.py               # AstrBot 插件入口
├─ platform_adapter.py   # 平台适配层
├─ platform_event.py     # 平台事件封装
└─ _conf_schema.json     # 插件配置项定义
```

## 动作链路

### 默认主路径（split_after_reply / middleware-first）

- 主聊天模型只负责正常回复文本，不要求内联 `<@anim {...}>`。
- 交互中间件在 prompt contributor 中注入动作能力/运行态上下文，并注册 `ag99live.motion` Persona Effect；result contributor 从 `view.effect_calls` 消费该 effect 并返回 `client_objects`。
- 后端从 `platform_extras` / `client_objects` 中读取动作载荷，并与文本、音频一起广播到前端。
- 若 runtime 内部明确启用了额外 fallback 组件，它的结果也必须回到同一条 `engine.motion_*` 协议链路和同一 segment identity。

### 兼容路径（inline_first）

- Adapter 在请求主模型前注入 `<@anim {...}>` 输出契约。
- 主回复末尾若包含合法 `<@anim {...}>`，则优先提取并广播动作载荷。
- 当前 inline contract 使用 `engine.motion_intent.v3`，字段来自当前模型的 `semantic_axis_profile`。

### 动作 selector 输出

- 当前主动作载荷为 `engine.motion_intent.v3`，前端 `ModelEngine` 根据 `semantic_axis_profile` 编译为 `engine.parameter_plan.v2` 再执行。
- v3 的 `axes` 是 flat number map，例如 `"head_yaw": 62`；LLM 契约不包含 `mode`，Adapter 归一化后补 `mode: "expressive"`。
- 自动动作链路不允许 LLM 输出 `choice`、`motion_id`、catalog motion、motion3、exp3 或旧播放文件引用。
- `motion_prompt_instruction` 会注入中间件动作上下文或 selector prompt，用于影响动作风格和幅度；只有显式启用 `inline_first` 时才会注入 inline contract。
- 中间件 prompt 只暴露 profile 中的 `primary/hint` axes，禁止输出 `derived/runtime/ambient/debug` axes。

## 与前端协同的关键点

- 每条交互消息都带 `turn_id`，前后端只按这一个轮次 ID 做会话协调。
- 每个 assistant segment 的 `output.text / output.audio / engine.motion_*` 都必须携带非空 `message_id`；前端用它把这些消息聚合到同一个 `TurnPlaybackSegment`。
- 当前后端主链路只广播 `engine.motion_intent`；前端负责把 intent 编译为 `engine.parameter_plan.v2` 后执行。
- `semantic_axis_profile` / `calibration_profile` / `voice_following_profile` / `parameter_action_library` / `base_action_library` 由 `system.model_sync` 下发。
- `system.semantic_axis_profile_saved` / `system.semantic_axis_profile_save_failed` 用于 Profile Editor 保存结果确认，不再依赖 `system.model_sync` 推断保存成败。
- 一个 user input 对应一个 turn，但一个 turn 内可能输出多个 assistant segment。
- `control.synth_finished` 表示该 turn 的输出队列逻辑关闭，不应再追加新的 `output.*` / `engine.motion_*` segment；它不要求早于所有前端播放完成。
- 为容忍传输和调度顺序，同一 `turn_id / message_id` 的晚到媒体可在前端最终结算前补齐已知 segment；这不允许创建新 segment，也不允许重复播放已 release / started / terminal 的音频。
- 前端在 `synth_finished` 已到且所有 segment 播放完成后回传 `control.playback_finished`；后端收到后再发 `control.turn_finished`。
- `output.audio.audio_url` 指向插件侧 HTTP 静态资源，通常是 `/cache/audio/*.wav`；有 TTS 文件但前端无声时，应先验证该 URL 在配置的 `host / http_port` 上是否可达。
- 麦克风输入现在按“单段录音”组织：一段采集内的 `input.audio_stream_start`、WebSocket binary PCM16LE chunk 与 `input.audio_stream_end` 共享同一个新的 `turn_id` 和 `stream_id`；后端 STT ingress 按 `stream_id` 汇总音频，不再把不同输入段混到一个全局缓冲。
- 若前端检测到发送积压，会在 `input.audio_stream_end` 中带上 `dropped: true`，后端直接丢弃该段转写。
- 切换麦克风设备时，前端会先正常结束旧输入段，再启动新输入段；收到 `control.interrupt` 时，前端会把已释放的 segment 音频写成失败终态后再清理播放 runtime。
- Windows / Electron 前端现在优先使用主进程 DirectShow/ffmpeg 原生麦克风枚举与采集；原生路径直接采集 `s16le`，渲染进程通过二进制音频帧发送给插件侧。
- `input.raw_audio_data` / `input.mic_audio_end` 仍保留为旧前端和调试脚本兼容路径，不是当前 Electron 前端主路径。
- 按键说话模式会以 `reason="ptt_release"` 结束本段录音；对插件侧来说它仍是一段普通麦克风输入。

## 远程执行器 / Windows 操作

AG99live 远程执行器当前走任务委托链路：

```text
用户请求操作电脑
  -> remote_operator middleware 注入/仲裁
    -> AstrBot core 输出 {"computer","profile","prompt"}
      -> RemoteOperatorRuntime
        -> Codex app-server WebSocket / Computer Use
        -> OpenCode CLI / opencode serve
```

当前关键边界：

- `_conf_schema.json` 的 `remote_operator_computer_entries` 配置执行器 key、用户可读名称、后端类型和固定执行参数。
- `backend=codex_app_server` 用于 Windows 桌面、应用、浏览器和 Computer Use 操作，endpoint 填 Codex app-server WebSocket 地址。
- `backend=opencode` 用于代码、文件、命令、日志和项目开发任务；`model`、`variant`、`workdir` 均由配置锁定，不由聊天模型决定。
- Adapter 会 probe endpoint 并只向 prompt 注入在线电脑。
- 对桌面/软件/电脑操作类请求，remote operator middleware 会要求核心只输出三字段 JSON，不允许核心直接调用 shell、浏览器、CUA 或输出底层步骤。
- `RemoteOperatorRuntime` 会查找 app-server 的 `computer-use:computer-use` skill，并把该 skill 与任务文本一起作为 turn 输入。
- Windows 桌面观察、点击、输入等底层操作由 Codex app-server / Computer Use 执行；Adapter 不直接持有本机桌面操作权限。
- 执行结果以 `remote_operator_result` 来源重新进入 AstrBot 事件，避免远程执行器结果再次触发远程执行器。

当前结构注意点：

- 文档语义要求 `synth_finished` 是 turn 级输出队列关闭信号。
- 如果同一 turn 内会多次输出 assistant segment，后端必须确保最后一个 segment 之后才发送 `synth_finished`。
- 这不是单条音频生成完成信号，也不是整轮完成信号。

## 关键配置

- `motion_generation_mode`：动作生成链路，默认 `split_after_reply`（middleware-first）；可选 `inline_first` 兼容路径。
- `motion_analysis_provider_id`：动作分析 / realtime motion selector 使用的 Provider。
- `motion_prompt_instruction`：动作 intent 生成的补充指令，默认要求 Live2D 表现更夸张。
- `remote_operator_default_computer` / `remote_operator_computer_entries`：远程执行器路由和后端配置；支持 `codex_app_server` 与 `opencode`。
- `remote_operator_default_profile` / `remote_operator_profiles`：远程执行器执行档位。Codex app-server 后端使用该档位选择 turn 模型与 effort；OpenCode 后端使用 entry 内固定的 `model` / `variant`。

当前 realtime motion selector 的参考策略：

- 自动动作链路不再把旧 motion/exp3 reference templates 或 catalog motion 作为模型可选项注入。
- selector prompt 使用当前 `SemanticAxisProfile` 轴说明、动作指令、用户手调样本形成的风格偏好和 fallback pose 候选。
- fallback pose 候选来源优先级为：用户保存的手调结果 -> `Expressions/*.exp3.json` 显式参数抽取 -> 当前 `SemanticAxisProfile.parameter_bindings` 可映射参数抽取；三层都不可用时才使用默认 neutral pose；最终仍输出 `engine.motion_intent.v3` flat axes。

## 开发与验证

安装依赖：

```powershell
pip install -r astrbot_plugin_ag99live_adapter/requirements.txt
```

运行测试：

```powershell
python -m pytest astrbot_plugin_ag99live_adapter/tests -q
```

最近一次完整测试记录：`146 passed`（2026-05-12）。
