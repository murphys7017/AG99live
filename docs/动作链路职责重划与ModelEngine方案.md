# 动作链路职责重划与ModelEngine方案

> 状态：历史设计文档。当前运行协议已经破坏性收口到 `engine.motion_intent.v2 -> engine.parameter_plan.v2`，不再保留 v1 兼容路径。当前有效状态以 `V2当前实现状态与下一步.md`、`主轴重构计划/README.md` 和 `后端主导数据边界与执行计划.md` 为准。

快照日期：2026-04-25

## 结论

- 后端保留消息接入、Turn 生命周期、中断、动作契约注入、主回复提取、无提取时的二次请求兜底、TTS 前隐藏标记清洗。
- 后端不再负责把动作语义组装成可执行 `engine.parameter_plan.v1`。
- 前端新增 `ModelEngine`，负责把“12 轴动作意图”编译成可执行 plan，并负责播放执行。
- 二次请求保留在后端，但二次请求的产物只到“动作意图”层，不到“执行计划”层。

## 当前实现事实

### 后端现状

- 主回复前，后端会向模型注入 `<@anim {...}>` 输出契约。
- 当前契约已经切到要求模型输出 `engine.motion_intent.v1`。
- 主回复没有提取到合法内联动作时，后端会发起 realtime 二次请求。
- realtime 二次请求当前主路径产物已经收口为 `engine.motion_intent.v1`。
- 后端已新增 `motion_prompt_instruction`，作为动作意图生成阶段的用户可配置风格/幅度指令。
- `motion_prompt_instruction` 同时进入主回复 inline contract 和 realtime selector prompt，但不改变协议结构。
- 后端旧 plan 编译路径已从生产模块移除；以下编译内容已迁到前端 `ModelEngine`：
  - `idle/expressive` 判定
  - `timing` 生成
  - `supplementary_params` 生成
  - `calibration_profile` 应用

### 前端现状

- 前端已经具备 Direct Parameter 播放链路。
- 前端已经收到 `ModelSummary` 内的：
  - `base_action_library`
  - `parameter_action_library`
  - `calibration_profile`
- 前端已经具备 plan 解析、retime、去重、soft handoff、最终执行能力。
- 前端已新增 `ModelEngine` 表现倍率设置：
  - 全局 `motionIntensityScale`，默认 `1.35`。
  - 12 轴 `axisIntensityScale`，默认全 `1.0`。
  - 设置窗口可调整，Desktop snapshot 负责持久化。
  - 编译阶段只放大 `expressive` intent，不放大 `idle`。

## 问题定义

当前后端的职责已经超过“适配器 / 中转站”边界。

越界点不是“二次请求存在”，而是“二次请求后的 plan 编译仍放在后端”。

应保留在后端的部分：

- AstrBot Provider 调用
- turn/session/interrupt 管理
- 主回复提取失败后的兜底请求

应迁移到前端的部分：

- 意图到 plan 的编译
- supplementary 参数推导
- calibration 执行层应用
- timing 生成与音频/口型协调
- 最终播放与停止

## 迁移完成定义

本次迁移不能只做到“后端发送 `engine.motion_intent`，前端能播放”。完成标准是：旧后端动作编译器承担的 plan 生成能力，必须在前端 `ModelEngine` 中有等价实现、等价测试或明确替代方案。

### 必须完整承接的后端能力

来源主要是 `astrbot_plugin_ag99live_adapter/motion/realtime_motion_plan.py` 中旧 `build_plan_from_axes()` 及其辅助逻辑。

- selector 输出到 12 轴 intent 的标准化与严格校验。
- `idle/expressive` 判定，包括 idle deadzone 规则。
- 非 neutral 情绪的低幅度动作增强策略，避免非中性情绪输出近似无动作。
- `duration_ms / duration_hint_ms` 到执行 timing 的映射。
- 根据音频剩余时长重定时，且不破坏最小 blend/hold 约束。
- `parameter_action_library` 优先的 supplementary 参数选择。
- `base_action_library` 回退选择。
- supplementary 参数去重、避让主轴参数、限制最大数量。
- supplementary `target_value` 和 `weight` 的幅度计算。
- calibration profile 的前端使用策略：编译期用于选择/避让，执行期交给 Live2D runtime 映射。
- `model_calibration_profile` 继续写入最终 plan，供 `lappmodel.ts` 执行态使用。
- 缺字段、非法 schema、非法轴值必须显式 warning/error 并拒绝，不允许静默补 neutral。
- 轴缺失是唯一允许的后端归一化例外：必须 warning，并将缺失轴补为 50，确保前端收到完整 12 轴 intent。

### 可以不一比一复制的部分

- Prompt 文案和 AstrBot Provider 调用仍属于后端。
- selector few-shot 和平台上下文构造仍属于后端。
- 最终动作体感参数可以在前端重新调权，但必须有文档说明偏离旧后端行为的原因。

### 完成后后端允许保留的动作逻辑

- inline contract 注入。
- inline `<@anim {...}>` 提取。
- realtime 二次请求。
- selector 输出解析为 `engine.motion_intent.v1`。
- motion intent schema 校验。
- 动作生成 prompt 指令注入。
- TTS 前隐藏动作标记清理。

### 完成后后端必须删除或退役的动作逻辑

- `build_plan_from_axes()`。
- `_build_supplementary_params()` 及只服务于 plan 编译的辅助函数。
- 后端 `engine.parameter_plan.v1` 主路径生成。
- 只接受 `plan` 的 debug preview API。
- 会把 invalid payload 误报成“无前端连接”的错误返回。

## 目标边界

### 后端职责

- 接收前端 `input.*`
- 下发 `output.* / control.* / system.* / engine.*`
- 管理 `turn_id`、session、中断、播放完成
- 向主聊天请求注入动作意图输出契约
- 从主回复提取动作意图
- 主回复没有合法动作意图时，发起二次请求获取动作意图
- 在 TTS 前剔除隐藏动作标记，避免合成脏文本

### 前端职责

- 接收动作意图
- 根据当前模型的 `parameter_action_library` / `base_action_library` / `calibration_profile` 编译 plan
- 根据用户设置的全局和单轴倍率调整 expressive intent 的实际表现幅度
- 记录最近真实执行的 plan，并在动作实验室中支持回放、手调和保存调参样本
- 生成 `timing`
- 生成 `supplementary_params`
- 应用 calibration
- 与音频、口型、idle/physics 做播放侧协调
- 执行、停止、去重、软衔接

## 推荐协议

### 推荐终态

新增动作意图 schema：

```json
{
  "schema_version": "engine.motion_intent.v1",
  "mode": "idle",
  "emotion_label": "neutral",
  "duration_hint_ms": 1200,
  "key_axes": {
    "head_yaw": { "value": 50 },
    "head_roll": { "value": 50 },
    "head_pitch": { "value": 50 },
    "body_yaw": { "value": 50 },
    "body_roll": { "value": 50 },
    "gaze_x": { "value": 50 },
    "gaze_y": { "value": 50 },
    "eye_open_left": { "value": 50 },
    "eye_open_right": { "value": 50 },
    "mouth_open": { "value": 50 },
    "mouth_smile": { "value": 50 },
    "brow_bias": { "value": 50 }
  },
  "summary": {
    "key_axes_count": 12
  }
}
```

说明：

- `key_axes` 继续沿用当前 12 轴结构，减少前后端切换成本。
- `duration_hint_ms` 是建议值，不是最终播放时间轴。
- 不再由后端下发 `supplementary_params`。
- 不再由后端下发执行态 `calibration_profile`。

### 过渡方案

为减少一次性改动，可以分两步：

1. 短期继续沿用消息类型 `engine.motion_plan`，但 `plan.schema_version` 改为 `engine.motion_intent.v1`。
2. 稳定后再新增消息类型 `engine.motion_intent`，彻底完成语义拆分。

推荐优先做第 1 步，先改边界，再改协议名。

## ModelEngine 当前结构

当前前端模块：

- `frontend/src/model-engine/contracts.ts`
- `frontend/src/model-engine/constants.ts`
- `frontend/src/model-engine/normalize.ts`
- `frontend/src/model-engine/settings.ts`
- `frontend/src/model-engine/compiler.ts`
- `frontend/src/model-engine/timing.ts`
- `frontend/src/model-engine/supplementary.ts`
- `frontend/src/model-engine/useModelEngine.ts`

职责划分：

- `contracts.ts`：定义 `motion_intent` 与编译结果类型
- `constants.ts`：12 轴常量、timing 默认值、idle deadzone
- `normalize.ts`：动作 payload 解析与开发期拒绝策略
- `settings.ts`：全局/单轴表现倍率、中文标签、设置归一化
- `compiler.ts`：`intent -> parameter_plan`
- `timing.ts`：生成 blend/hold/total duration
- `supplementary.ts`：从动作库推导 supplementary 参数
- `useModelEngine.ts`：turn/audio 调度、pending 队列、调用 `usePreviewMotionPlayer`

详细拆分与落地顺序见《[前端ModelEngine设计](./前端ModelEngine设计.md)》。

## 后端改造目标

建议把当前 `astrbot_plugin_ag99live_adapter/motion/realtime_motion_plan.py` 收缩为“动作意图生成器”，而不是“动作计划生成器”。

保留：

- selector prompt
- provider 调用
- 12 轴标准化
- 合法性校验

移出：

- `build_plan_from_axes`
- `timing` 构造
- `supplementary_params` 构造
- `calibration_profile` 执行态拼装

## 实施顺序

### Phase 1

- 在前端新增 `ModelEngine` 骨架。
- 将 Python 中的 plan 编译逻辑逐步迁到 TypeScript，不能只实现最小可播放版本。
- 前端先支持“动作意图 -> 本地编译 -> 执行”。

### Phase 2

- 后端新增动作意图 schema 与校验。
- realtime 二次请求改为只返回动作意图。
- 主回复内联契约从“输出完整 plan”改为“输出动作意图”。
- 严格化 selector 输出解析：缺字段、非法类型、非法值必须显式失败；缺失轴允许 warning 后补 50，但不能静默补默认动作。

### Phase 3

- 前端消息处理改为优先消费动作意图，再本地编译。
- 验证 turn gating、音频起播、soft handoff、无音频兜底。
- 补齐旧后端 plan 编译器到前端 `ModelEngine` 的功能对照测试。

### Phase 4

- 删除后端旧的 plan 编译路径。
- 清理只服务于后端 plan 编译的配置项、测试和文档。
- debug / preview API 改为 motion payload 级接口，按 schema 自动区分 intent 与 legacy plan。

## 迁移验收清单

- 后端 realtime 和 inline 主路径只下发 `engine.motion_intent.v1`。
- 前端 `ModelEngine` 对 `engine.motion_intent.v1` 编译出的 `engine.parameter_plan.v1` 包含完整 `timing/key_axes/supplementary_params/model_calibration_profile`。
- 前端 supplementary 选择结果覆盖 parameter library 优先、base library 回退、去重、避让主轴参数、最大数量限制。
- 前端 timing 覆盖 hint/default/audio-sync 三种来源。
- 前端动作强度设置覆盖全局倍率、12 轴倍率、重置和持久化。
- 前端和底层播放器对缺失 `emotion_label`、缺失轴、非法 schema 都拒绝并 warning；缺轴补 50 只能发生在后端 intent 归一化阶段，不能在前端静默补。
- 后端旧 `build_plan_from_axes()` 不再被生产路径或测试依赖。
- debug preview 能明确返回 invalid payload、schema mismatch、no websocket 三类不同错误。
- `python -m pytest astrbot_plugin_ag99live_adapter/tests -q` 通过。
- `cd frontend && npm run typecheck` 通过。
- `cd frontend && npm run build:web` 通过。

## 兼容要求

- 二次请求必须继续保留在后端。
- `turn_id` 继续由后端下发，前端不自行生成。
- TTS 前的隐藏标记清洗继续保留在后端。
- 模型扫描结果仍由后端生成并通过 `system.model_sync` 下发。

## 非目标

- 本轮不调整 AstrBot 插件加载结构。
- 本轮不调整 Live2D 扫描产物结构。
- 本轮不先做音频驱动口型重构。
- 本轮不先引入新的动作资源格式。

## 当前建议

- 先做职责收口，不先做消息名切换。
- 先让前端具备 `intent -> plan` 编译能力，再回头收缩后端。
- 所有新增文档、测试、配置，都以“后端到动作意图为止，前端负责编译执行”为准。
