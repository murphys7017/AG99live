# 文档索引（AG99live）

本文档用于区分“当前有效文档”和“已归档文档”。

当前代码事实以源码为准；当前有效文档用于解释最新结构，历史和归档文档只保留设计脉络。

## 当前有效

- [README](../README.md)
  - 当前项目总览。
  - 与最新代码状态相符：动作链路以 `inline_first` 为默认主路径，运行时协议以 v2 为主。
- [astrbot_plugin_ag99live_adapter/README](../astrbot_plugin_ag99live_adapter/README.md)
  - AstrBot adapter 的当前配置、协议和动作生成模式说明。
  - 与最新代码状态相符：`motion_generation_mode` 配置默认值为 `inline_first`，可切 `split_after_reply` / `text_only`。
- [V2 当前实现状态与下一步](./V2当前实现状态与下一步.md)
  - 当前 v2 实现快照、已完成项、剩余工作。
  - 需要与当前代码一起阅读：它是现状快照，不是永久真理。
- [当前前后端动作链路结构说明](./当前前后端动作链路结构说明.md)
  - 当前前后端文本 / 音频 / 动作链路的结构手册。
  - 当前版本已切到 `TurnPlaybackSession` 为前端播放轮次真源。
- [文本语音动作同步播放编排设计](./文本语音动作同步播放编排设计.md)
  - 当前文本 / 音频 / 动作软同步起播方案。
  - 重点说明 `Session + Orchestrator + ModelEngine` 这一段如何协作。
- [后端主导数据边界与执行计划](./后端主导数据边界与执行计划.md)
  - 当前数据归属边界和后续结构收口方向。
  - 它是结构方向文档，主要回答“哪些数据该归谁管”。
- [中间件防御性编程审阅与整改计划](./中间件防御性编程审阅与整改计划.md)
  - 当前中间层里哪些 guard 是合理边界防御，哪些 guard 是架构补偿型兜底。
  - 用于后续逐项收口 `useAdapterConnection`、`turn_coordinator` 和 session identity。
- [useAdapterConnection收口实施计划](./useAdapterConnection收口实施计划.md)
  - 当前前端协议接入层的分阶段拆解施工图。
  - 重点说明先拆哪里、如何保护现有播放语义、每一步怎么验收。

## 已归档

- [archive/README](./archive/README.md)
- [前端Turn Playback Session收口计划](./archive/前端Turn%20Playback%20Session收口计划.md)
- [前后端严格审阅报告](./archive/前后端严格审阅报告.md)
- [动作链路职责重划与ModelEngine方案](./archive/动作链路职责重划与ModelEngine方案.md)
- [前端ModelEngine设计](./archive/前端ModelEngine设计.md)
- [ModelEngine驱动系统边界与分层设计](./archive/ModelEngine驱动系统边界与分层设计.md)
- [前端动作强度设置计划](./archive/前端动作强度设置计划.md)
- [主轴重构计划/README](./archive/主轴重构计划/README.md)
- [ModelEngine主参数语义设计](./archive/ModelEngine主参数语义设计.md)
- [V2 Live2D扫描设计草案](./archive/V2%20Live2D扫描设计草案.md)
- [V2动作引擎设计草案](./archive/V2动作引擎设计草案.md)
- [V2前端开发计划](./archive/V2前端开发计划.md)
- [V2适配器开发计划](./archive/V2适配器开发计划.md)
- [V2消息适配审阅与进度](./archive/V2消息适配审阅与进度.md)
- [动作分析并入单次请求可行性评估](./archive/动作分析并入单次请求可行性评估.md)
- [二期架构方向草案](./archive/二期架构方向草案.md)

## 使用建议

- 想快速了解项目现状：先读根目录 README，再读《V2 当前实现状态与下一步》。
- 想理解文本 / 音频 / 动作播放链路：先读《当前前后端动作链路结构说明》，再读《文本语音动作同步播放编排设计》。
- 想继续做结构优化：读《后端主导数据边界与执行计划》。
- 想查为什么以前这样设计：再查 `archive/` 里的历史计划和设计稿。
