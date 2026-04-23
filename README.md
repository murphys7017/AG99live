# AG99live

欢迎点燃自己的历史。

AG99live 是桌宠项目 V2。  
项目前期受到 Open-LLM-VTuber（OLV）启发，但 V2 的目标是独立建设 `AstrBot 插件适配器 + 本地桌面 runtime`，而不是继续做 V1 的改造分支。

## 当前状态（2026-04-23）

已完成：

- V2 协议主链路已切换：`input / output / control / system / engine`。
- `adapter` 已作为 AstrBot 插件根目录可运行，保留 `WebSocket` 实时链路 + `HTTP` 静态资源链路。
- Live2D 扫描已具备参数/表情/motion 基础解析，并产出 `base_action_library`。
- 基础动作库已接入“宽进严出”流程：规则初筛 + 可选 LLM 严格筛选 + fallback 回退。
- `frontend` 已有桌宠窗口、设置窗口、历史窗口、动作实验室窗口（Action Lab）。
- Action Lab 已可从扫描结果选择动作原子，生成预览计划并发送 `engine.motion_plan` 测试消息。
- 主聊天链路已支持内联动作计划：adapter 会向 AstrBot 主请求注入 `<@anim ...>` 输出契约，并优先从主回复中提取 `engine.motion_plan`。
- 回复后实时动作计划二次请求仍保留，但仅作为主回复未产出合法 `<@anim ...>` 时的兜底路径。

进行中：

- 前端真实动作引擎执行仍在联调中，当前重点是稳定参数计划写入与卡死诊断。
- `engine.motion_plan` 已接入主聊天提取与前端消费，仍需继续收敛真实 Live2D 执行稳定性。

## 目录

```text
AG99live/
├─ docs/
├─ frontend/  # Electron + Vue 桌宠客户端（pet/settings/history/action_lab）
├─ adapter/   # AstrBot 插件（消息适配、语音链路、Live2D 扫描）
└─ README.md
```

## 文档入口

- [V2 当前实现状态与下一步](./docs/V2当前实现状态与下一步.md)
- [V2 消息适配审阅与进度](./docs/V2消息适配审阅与进度.md)
- [V2 适配器开发计划](./docs/V2适配器开发计划.md)
- [V2 Live2D 扫描设计草案](./docs/V2%20Live2D扫描设计草案.md)
- [V2 动作引擎设计草案](./docs/V2动作引擎设计草案.md)
- [V2 前端开发计划](./docs/V2前端开发计划.md)
