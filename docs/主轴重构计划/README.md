# 主轴重构计划

快照日期：2026-04-26

## 目标

本目录用于承载 ModelEngine 从“固定 12 轴”重构为“动态主轴 / semantic axis profile”的完整计划。

核心目标：

- 不再把固定 12 轴作为架构核心。
- 每个 Live2D 模型拥有自己的动态主轴配置。
- 系统先自动扫描生成初版主轴 profile。
- 前端允许用户选择哪些参数是主轴、哪些是派生轴、哪些由 runtime 控制。
- 联动关系由 profile 配置，而不是写死在代码常量中。
- 后端 prompt 根据 profile 动态生成参数语义说明。
- ModelEngine 根据 profile 编译动作意图，最终输出可执行参数计划。

## 计划文档

建议按顺序阅读：

1. [01 动态主轴总体方案](./01-动态主轴总体方案.md)
2. [02 Profile Schema 与自动扫描](./02-Profile-Schema与自动扫描.md)
3. [03 Prompt 语义重写方案](./03-Prompt语义重写方案.md)
4. [04 分阶段执行计划](./04-分阶段执行计划.md)

## 当前共识

### 1. 固定 12 轴不再是架构核心

现有 12 轴只能作为历史实现和初始迁移参考，不再作为未来代码的核心抽象。

后续核心抽象应是：

```text
SemanticAxisProfile
```

### 2. 主轴由模型 profile 决定

不同 Live2D 模型可以拥有不同主轴：

- 有些模型有标准头部参数。
- 有些模型有更完整的身体参数。
- 有些模型有耳朵、尾巴、道具、衣服等特殊参数。
- 有些模型的嘴、眉、眼参数方向和范围不同。

所以主轴不能继续用固定 union 写死。

### 3. 先自动扫描，再允许用户修正

理想流程：

```text
Live2D 文件夹
-> 参数/表情/motion 扫描
-> 自动生成 semantic_axis_profile.json
-> 前端 Action Lab / Profile Editor 人工校正
-> 保存回后端模型目录
-> ModelEngine / prompt / runtime 使用该 profile
```

当前事实来源明确为：

```text
后端模型目录中的 semantic_axis_profile.json
```

前端只持有编辑副本，不单独作为运行时事实来源。

### 4. 控制权必须写进 profile

每个 axis 都需要声明控制权：

```text
primary   = LLM 主控
hint      = LLM 可给弱提示
 derived  = ModelEngine 派生
runtime   = 音频/口型/眨眼等运行时驱动
ambient   = 待机/呼吸/背景动作
debug     = 只调试，不进入生产 prompt
```

### 5. Prompt 不再硬编码参数说明

后端 prompt 应从 profile 动态生成。

Prompt 的核心不再是“这里有 12 个参数”，而是：

```text
你正在控制一个 Live2D 模型。
你可以优先控制 primary semantic axes，也可以在明确标注的情况下输出 hint axes。
每个 axis 的 50/高值/低值/推荐范围/适用场景如下。
不要控制 runtime/ambient axes。
```

## 当前实现进度

### 已完成

- `Phase 0-4` 已完成的是动态主轴的 profile foundation/editor，不是执行链迁移：
  - 后端 canonical profile 文件落地
  - `system.model_sync` 下发 `semantic_axis_profile`
  - `system.semantic_axis_profile_save` 回写闭环
  - `revision` / `source_hash` / `stale` 冲突保护
  - 固定模板外的扫描参数先以 `debug` 轴进入 profile
  - 扫描参数生成稳定的 AG99live semantic axis id，Live2D 原始参数 ID 只保留在 `parameter_bindings[].parameter_id`
  - 模型文件 hash 变化时先按 profile 自身结构读取并标记 `stale`，不因当前参数表变化提前阻断用户已编辑 profile
- 第二轮 Profile Editor 主体能力已完成：
  - Action Lab 中新增 `Profile Editor`
  - 可编辑字段：
    - `label`
    - `control_role`
    - `description`
    - `usage_notes`
    - `semantic_group`
    - `positive_semantics`
    - `negative_semantics`
    - `value_range`
    - `soft_range`
    - `strong_range`
    - `parameter_bindings`
    - `couplings`
  - 可按角色/文本筛选 axes
  - 可批量把扫描出的 `debug` axes 提升为生产控制角色，或把已有 axes 降回 `debug`
  - 可新建自定义主轴草稿，保存前需显式补齐描述、使用说明、正/负语义、parameter binding，并确认当前轴配置
  - 前端保存前会一次性列出 profile 配置错误
  - 后端保存层会严格拒绝非法 axis id、非法数值、非法 range、跨轴重复 binding、负 `scale/deadzone/max_delta`、非法 coupling 和 coupling cycle
- 第三轮动态主轴执行链最小闭环已完成：
  - `system.semantic_axis_profile_saved` / `system.semantic_axis_profile_save_failed` 已作为专用保存 ack/fail 协议落地
  - `system.semantic_axis_profile_save` 请求要求 `request_id/model_name/profile_id/expected_revision/profile` 必填
  - realtime selector prompt 已从当前 `semantic_axis_profile` 生成，只暴露 `primary/hint` axes
  - inline `<@anim>` contract 已切到 `engine.motion_intent.v2`
  - 前端 `ModelEngine` 已支持 `engine.motion_intent.v2 -> engine.parameter_plan.v2`，并按 coupling DAG 做多跳传播
  - `parameter_plan.v2` 直接携带 `parameters[].parameter_id/target_value/weight`
  - Live2D runtime 已支持按 `parameter_id` 写入 v2 plan
  - v2 路径对 unknown/forbidden/non-number axis 按 30% 主参数错误率阈值处理；超过阈值 hard fail，未超过则忽略错误项并诊断
  - v2 路径对重复 parameter、非法 source、非法 weight、不可写 parameter 均 hard fail
  - v2 路径对语义值或 target 越界会夹到对应极限值并记录 warning

### 尚未完成

- 真实 Live2D 模型上的 v2 动作效果实机验证与参数范围标定
- 前端自动化测试框架
- 固定 12 轴核心路径删除

### 当前阶段判断

当前已经不再处于“只做方案”的阶段，而是处于：

```text
动态主轴底座已落地
-> Profile Editor 主体编辑和批量主轴配置已落地
-> profile save 专用 ack/fail 已落地
-> profile-driven prompt / compiler / runtime v2 已完成最小闭环
-> 下一步进入实机验证与 Phase 8 旧 12 轴核心路径清理
```

当前固定 12 轴链路仍然存在，属于过渡期保留的 v1 兼容/调试路径。主执行链已经迁移到：

```text
motion_intent.v2
-> profile-driven prompt
-> profile-driven compiler
-> parameter_plan.v2 runtime
```

Profile Editor 的配置已经可以参与实际动作生成和播放。剩余工作是实机校准、完善测试，以及删除 v1 固定 12 轴核心路径。

补充说明：

- 设置页中的旧 12 轴逐轴倍率已从常规界面下线，当前只保留真正作用于 v2 的全局强度倍率。
- `MotionTuningPanel` 已降级为遗留兼容面板，仅在存在 v1 历史记录或样本时显示，不再作为当前主调参入口。
- `BaseActionPreviewPanel` 与 preview/player/runtime 中的 v1 兼容分支仍在，因此 Phase 8 还没有完成。

## 暂不做的事

重构计划不要求第一阶段同时完成：

- 完整实时口型。
- 待机/呼吸系统重构。
- 插帧、曲线、参数平滑。
- 复杂 motion mixer。
- 多模型 profile 在线训练。

这些应在动态主轴底座稳定后再做。

## 与现有文档关系

- `archive/ModelEngine主参数语义设计.md`：历史设计文档，已被本重构计划取代；仅保留“12 轴不应同级主控”的分析。
- `ModelEngine驱动系统边界与分层设计.md`：解释 ModelEngine / Runtime / 后端边界。
- 本目录：把上述共识转成可执行重构路线。
