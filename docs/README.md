# 文档索引（AG99live）

本文档用于区分“当前有效文档”“阶段性参考文档”“历史设计文档”和“已归档文档”。

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
  - 本轮已更新：默认动作链路、起播编排层、播放完成边界与最新代码对齐。
- [当前前后端动作链路结构说明](./当前前后端动作链路结构说明.md)
  - 当前前后端文本 / 音频 / 动作链路的结构手册。
  - 本轮已更新：补入 `useTurnPlaybackOrchestrator` 起播编排层。
- [文本语音动作同步播放编排设计](./文本语音动作同步播放编排设计.md)
  - 新增软同步起播方案。
  - 与最新代码状态相符：对应 `frontend/src/composables/useTurnPlaybackOrchestrator.ts`。
- [后端主导数据边界与执行计划](./后端主导数据边界与执行计划.md)
  - 当前数据归属边界和后续结构收口方向。
  - 基本与最新代码状态相符，但部分段落仍带计划语气；应作为结构方向文档阅读。

## 已归档

- [archive/README](./archive/README.md)
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
- 想理解文本 / 音频 / 动作播放链路：读《当前前后端动作链路结构说明》和《文本语音动作同步播放编排设计》。
- 想继续做结构优化：读《后端主导数据边界与执行计划》。
- 想查为什么以前这样设计：再查“历史设计”和 `archive/`。
