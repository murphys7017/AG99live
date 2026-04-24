# adapter

AG99live V2 的 AstrBot 插件侧实现。该目录负责协议桥接、会话调度、媒体处理、Live2D 扫描与 realtime motion plan 生成。

## 核心职责

- 接收前端 `input.*` 消息并转为 AstrBot 事件。
- 发送 `output.* / control.* / system.* / engine.*` 消息回前端。
- 管理 turn 生命周期，保证文本/语音/动作消息在同一轮次可追踪。
- 扫描 Live2D 资源并产出结构化能力信息。
- 生成 `engine.parameter_plan.v1` 动作计划（内联优先，realtime 兜底）。

## 目录结构

```text
adapter/
├─ adapter/              # 运行时核心模块（protocol/turn/runtime/motion/scan）
├─ tests/                # 单元测试
├─ live2ds/              # 模型资源
├─ main.py               # AstrBot 插件入口
├─ platform_adapter.py   # 平台适配层
├─ static_resources.py   # 静态资源与调试接口
└─ _conf_schema.json     # 插件配置项定义
```

## 动作计划链路

### 主路径（内联）

- Adapter 在请求主模型前注入 `<@anim {...}>` 输出契约。
- 主回复末尾若包含合法 `<@anim {...}>`，则直接提取并广播 `engine.motion_plan`。

### 兜底路径（realtime）

- 主回复无合法内联动作时，触发 `realtime_motion_plan` 生成。
- 产物会按 `engine.parameter_plan.v1` 校验后再下发前端。

## 与前端协同的关键点

- 每条消息都带 `turn_id`，用于前端做轮次 gating 与时间轴协调。
- `engine.motion_plan` 已支持 `calibration_profile` 辅助前端安全执行。
- supplementary 参数支持从 `parameter_action_library` 抽取，并可回退到 `base_action_library`。

## 关键配置（`_conf_schema.json`）

- `enable_inline_motion_contract`：是否启用主请求内联动作契约。
- `enable_realtime_motion_plan`：是否启用无内联时的 realtime 兜底。
- `motion_analysis_provider_id`：动作语义分析模型 Provider。
- `realtime_motion_timeout_seconds`：realtime 生成超时（秒）。
- `realtime_motion_fewshot_enabled`：是否启用 few-shot。
- `realtime_motion_platform_context_enabled`：是否注入平台上下文。
- `enable_action_llm_filter`：是否启用基础动作库 LLM 严格筛选。

## 开发与验证

安装依赖：

```powershell
pip install -r adapter/requirements.txt
```

运行测试：

```powershell
python -m pytest adapter/tests -q
```

当前基线：`50 passed`（2026-04-23）。
