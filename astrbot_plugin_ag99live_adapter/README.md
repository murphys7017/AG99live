# astrbot_plugin_ag99live_adapter

AG99live V2 的 AstrBot 插件侧实现。该目录负责协议桥接、会话调度、媒体处理、Live2D 扫描与 realtime motion intent 生成。

## 核心职责

- 接收前端 `input.*` 消息并转为 AstrBot 事件。
- 发送 `output.* / control.* / system.* / engine.*` 消息回前端。
- 管理 turn 生命周期，保证文本/语音/动作消息在同一轮次可追踪。
- 扫描 Live2D 资源并产出结构化能力信息。
- 生成并下发动作意图（内联优先，realtime 兜底），不再负责长期持有前端执行 plan 的编译职责。

## 目录结构

```text
astrbot_plugin_ag99live_adapter/
├─ protocol/             # 协议常量、模型、解析与构造
├─ transport/            # WebSocket、静态资源与路由
├─ runtime/              # runtime state、turn 协调、session/chat 状态
├─ services/             # 媒体、消息、语音、兼容层服务
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

### 主路径（内联）

- Adapter 在请求主模型前注入 `<@anim {...}>` 输出契约。
- 主回复末尾若包含合法 `<@anim {...}>`，则优先提取并广播动作载荷。
- 当前 inline contract 使用 `engine.motion_intent.v2`，字段来自当前模型的 `semantic_axis_profile`。

### 兜底路径（realtime）

- 主回复无合法内联动作时，触发 `realtime_motion_plan` 生成。
- 当前 realtime 主路径产物为 `engine.motion_intent.v2`，前端 `ModelEngine` 根据 `semantic_axis_profile` 编译为 `engine.parameter_plan.v2` 再执行。
- `motion_prompt_instruction` 会注入 inline contract 与 realtime selector prompt，用于影响动作风格和幅度。
- realtime prompt 只暴露 profile 中的 `primary/hint` axes，禁止输出 `derived/runtime/ambient/debug` axes。

## 与前端协同的关键点

- 每条消息都带 `turn_id`，用于前端做轮次 gating 与时间轴协调。
- 前端同时兼容 `engine.motion_plan` 与 `engine.motion_intent`，但开发期要求消息类型与 payload 字段严格对应。
- `semantic_axis_profile` / `calibration_profile` / `parameter_action_library` / `base_action_library` 由 `system.model_sync` 下发。
- `system.semantic_axis_profile_saved` / `system.semantic_axis_profile_save_failed` 用于 Profile Editor 保存结果确认，不再依赖 `system.model_sync` 推断保存成败。

## 关键配置（`_conf_schema.json`）

- `enable_inline_motion_contract`：是否启用主请求内联动作契约。
- `enable_realtime_motion_plan`：是否启用无内联时的 realtime 兜底。
- `motion_analysis_provider_id`：动作语义分析模型 Provider。
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

当前基线：`101 passed`（2026-04-27）。
