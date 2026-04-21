# AG99live

欢迎点燃自己的历史。

AG99live 是桌宠项目 V2。  
项目前期受到 Open-LLM-VTuber（OLV）启发，但 V2 的目标是独立建设 `AstrBot 插件适配器 + 本地桌面 runtime`，而不是继续做 V1 的改造分支。

## 当前状态（2026-04-21）

已完成：

- V2 协议主链路已切换：`input / output / control / system / engine`。
- `adapter` 已作为 AstrBot 插件根目录可运行，保留 `WebSocket` 实时链路 + `HTTP` 静态资源链路。
- Live2D 扫描已具备参数/表情/motion 基础解析，并产出 `base_action_library`。
- 基础动作库已接入“宽进严出”流程：规则初筛 + 可选 LLM 严格筛选 + fallback 回退。
- `frontend` 已有桌宠窗口、设置窗口、历史窗口、动作实验室窗口（Action Lab）。
- Action Lab 已可从扫描结果选择动作原子，生成预览计划并发送 `engine.motion_plan` 测试消息。

进行中：

- 前端真实动作引擎执行（逐帧调度、混合、时长编排）尚未接入生产路径。
- `engine.*` 当前只落协议骨架与测试入口，尚未驱动真实 Live2D 动作播放。

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
