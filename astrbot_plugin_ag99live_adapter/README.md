# astrbot_plugin_ag99live_adapter

AG99live V2 的 AstrBot 插件侧实现。该目录负责协议桥接、turn 生命周期、媒体处理、Live2D 扫描，以及把中间件/主回复产生的动作载荷广播给前端。

## 核心职责

- 接收前端 `input.*` 消息并转为 AstrBot 事件。
- 发送 `output.* / control.* / system.* / engine.*` 消息回前端。
- 管理 turn 生命周期，保证文本/语音/动作消息在同一轮次可追踪。
- 扫描 Live2D 资源并产出结构化能力信息。
- 生成并下发动作用载荷；默认走 AstrBot 交互中间件主链路，由 `client_objects` / plugin hints 提供动作；`inline_first` 内联动作链路仅作为显式兼容路径保留。

## 目录结构

```text
astrbot_plugin_ag99live_adapter/
├─ protocol/             # 协议常量、模型、解析与构造
├─ transport/            # WebSocket、静态资源与路由
├─ runtime/              # runtime state、turn 协调、session/chat 状态
├─ services/             # 媒体、消息、语音服务
├─ motion/               # 动作意图生成与输出清洗
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
- 交互中间件在 prompt contributor 中注入动作能力/运行态上下文，在 result contributor 中返回 `client_objects` 或 plugin hints。
- 后端从 `platform_extras` / `client_objects` 中读取动作载荷，并与文本、音频一起广播到前端。
- 若 runtime 内部明确启用了额外 fallback 组件，它的结果也必须回到同一条 `engine.motion_*` 协议链路和同一 segment identity。

### 兼容路径（inline_first）

- Adapter 在请求主模型前注入 `<@anim {...}>` 输出契约。
- 主回复末尾若包含合法 `<@anim {...}>`，则优先提取并广播动作载荷。
- 当前 inline contract 使用 `engine.motion_intent.v2`，字段来自当前模型的 `semantic_axis_profile`。
- 如果中间件在 result contributor 阶段返回 `client_objects` / plugin hints 动作载荷，则后端优先广播这些结构化动作对象。

### 动作 selector 输出

- 当前主动作载荷为 `engine.motion_intent.v2`，前端 `ModelEngine` 根据 `semantic_axis_profile` 编译为 `engine.parameter_plan.v2` 再执行。
- `motion_prompt_instruction` 会注入中间件动作上下文或 selector prompt，用于影响动作风格和幅度；只有显式启用 `inline_first` 时才会注入 inline contract。
- 中间件 prompt 只暴露 profile 中的 `primary/hint` axes，禁止输出 `derived/runtime/ambient/debug` axes。

## 与前端协同的关键点

- 每条交互消息都带 `turn_id`，前后端只按这一个轮次 ID 做会话协调。
- 每个 assistant segment 的 `output.text / output.audio / engine.motion_*` 都必须携带非空 `message_id`；前端用它把这些消息聚合到同一个 `TurnPlaybackSegment`。
- 当前后端主链路只广播 `engine.motion_intent`；前端负责把 intent 编译为 `engine.parameter_plan.v2` 后执行。
- `semantic_axis_profile` / `calibration_profile` / `parameter_action_library` / `base_action_library` 由 `system.model_sync` 下发。
- `system.semantic_axis_profile_saved` / `system.semantic_axis_profile_save_failed` 用于 Profile Editor 保存结果确认，不再依赖 `system.model_sync` 推断保存成败。
- 一个 user input 对应一个 turn，但一个 turn 内可能输出多个 assistant segment。
- `control.synth_finished` 表示该 turn 的输出队列关闭，不会再追加新的 `output.*` / `engine.motion_*` segment；它不要求早于所有前端播放完成。
- 前端在 `synth_finished` 已到且所有 segment 播放完成后回传 `control.playback_finished`；后端收到后再发 `control.turn_finished`。
- 麦克风输入现在按“单段录音”组织：一段采集内的 `input.raw_audio_data` 与 `input.mic_audio_end` 共享同一个新的 `turn_id`；后端 STT ingress 也按这个 `turn_id` 分桶缓冲，不再把不同输入段混到一个全局缓冲。
- 若前端检测到发送积压，会在 `input.mic_audio_end` 中带上 `dropped: true`，后端直接丢弃该段转写。
- 切换麦克风设备时，前端会先正常结束旧输入段，再启动新输入段；收到 `control.interrupt` 时，前端会把已释放的 segment 音频写成失败终态后再清理播放 runtime。

当前结构注意点：

- 文档语义要求 `synth_finished` 是 turn 级输出队列关闭信号。
- 如果同一 turn 内会多次输出 assistant segment，后端必须确保最后一个 segment 之后才发送 `synth_finished`。
- 这不是单条音频生成完成信号，也不是整轮完成信号。

## 关键配置（`_conf_schema.json`）

- `motion_generation_mode`：动作生成链路，默认 `split_after_reply`（middleware-first）；可选 `inline_first` 兼容路径。
- `enable_inline_motion_contract`：兼容开关，`inline_first` 模式下是否启用主请求内联动作契约。
- `enable_realtime_motion_plan`：是否启用 runtime 内部的 realtime motion fallback 组件；如果该组件被明确调用，产物仍必须回到同一条 `engine.motion_*` 协议链路和同一 segment identity。
- `motion_analysis_provider_id`：动作分析 / realtime motion selector 使用的 Provider。
- `realtime_motion_timeout_seconds`：realtime 生成超时（秒）。
- `realtime_motion_fewshot_enabled`：是否启用 few-shot。
- `realtime_motion_platform_context_enabled`：是否注入平台上下文。
- `motion_prompt_instruction`：动作 intent 生成的补充指令，默认要求 Live2D 表现更夸张。
- `enable_action_llm_filter`：是否启用基础动作库 LLM 严格筛选。

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
