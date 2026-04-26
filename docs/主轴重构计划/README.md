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
你可以控制以下 primary semantic axes。
每个 axis 的 50/高值/低值/推荐范围/适用场景如下。
不要控制 runtime/ambient axes。
```

## 当前实现进度

### 已完成

- 第一轮基础设施已完成：
  - 后端 canonical profile 文件落地
  - `system.model_sync` 下发 `semantic_axis_profile`
  - `system.semantic_axis_profile_save` 回写闭环
  - `revision` / `source_hash` / `stale` 冲突保护
- 第二轮最小 UI 已完成：
  - Action Lab 中新增 `Profile Editor`
  - 可编辑字段：
    - `label`
    - `control_role`
    - `description`
    - `usage_notes`
    - `soft_range`
    - `strong_range`
  - `parameter_bindings` 当前只读展示

### 尚未完成

- `couplings` 编辑器
- `parameter_bindings` 编辑器
- `positive_semantics / negative_semantics` 完整编辑
- `profile-driven prompt`
- `ModelEngine compiler v2`
- `parameter_plan.v2 runtime`
- 固定 12 轴核心路径删除

### 当前阶段判断

当前已经不再处于“只做方案”的阶段，而是处于：

```text
动态主轴底座已落地
-> 最小 Profile Editor 已落地
-> 下一步进入 profile-driven 执行链迁移
```

## 暂不做的事

重构计划不要求第一阶段同时完成：

- 完整实时口型。
- 待机/呼吸系统重构。
- 插帧、曲线、参数平滑。
- 复杂 motion mixer。
- 多模型 profile 在线训练。

这些应在动态主轴底座稳定后再做。

## 与现有文档关系

- `ModelEngine主参数语义设计.md`：解释为什么 12 轴不是同级主控。
- `ModelEngine驱动系统边界与分层设计.md`：解释 ModelEngine / Runtime / 后端边界。
- 本目录：把上述共识转成可执行重构路线。
