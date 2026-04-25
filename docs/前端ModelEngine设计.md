# 前端ModelEngine设计

快照日期：2026-04-25

## 目标

在前端引入 `ModelEngine`，负责以下链路：

- 接收后端下发的动作意图或兼容动作计划
- 基于当前 `ModelSummary` 编译可执行 `DirectParameterPlan`
- 与音频起播、`turn_id`、软衔接、去重协同
- 调用现有 Live2D Direct Parameter 执行接口

核心目标不是“新增一个能播放 intent 的前端模块”，而是把旧后端 Model Engine / plan compiler 的执行计划编译职责完整迁移到前端。迁移完成前，不能删除后端旧逻辑；迁移完成后，后端不再生成 `engine.parameter_plan.v1`。

`ModelEngine` 不负责：

- WebSocket 连接
- `system.model_sync` 数据生产
- AstrBot Provider 调用
- Live2D 底层逐帧写参实现

## 当前前端事实

现有前端已经具备三块能力，但职责分散：

### 1. 入站消息接收

- `frontend/src/composables/useAdapterConnection.ts`
- 已负责接收 `engine.motion_plan`
- 已做 `turn_id` 过期过滤
- 当前只把原始 `plan` 放入 `state.inboundMotionPlan`

### 2. 播放时序协调

- `frontend/src/views/PetDesktopView.vue`
- 已负责：
  - 动作等待音频起播
  - 无音频兜底超时
  - 同轮 pending plan 缓存
  - 动作起播时按剩余音频时长 retime

### 3. 计划执行

- `frontend/src/composables/usePreviewMotionPlayer.ts`
- 已负责：
  - `engine.parameter_plan.v1` 解析
  - calibration 归一化
  - retime
  - 去重、重启节流、soft handoff
  - 调 `startDirectParameterPlan`

### 4. 底层运行时

- `frontend/src/live2d/WebSDK/src/lappmodel.ts`
- 已负责：
  - 轴绑定解析
  - supplementary 参数绑定
  - calibration 执行
  - 逐帧 overlay 写入

## 设计结论

`ModelEngine` 放在前端，但分两层：

### 核心层

纯函数，无 Vue 依赖，无 DOM 依赖。

职责：

- 解析动作意图
- 编译 `intent -> plan`
- 生成 timing
- 推导 supplementary
- 构造执行请求

### 协调层

带状态，允许使用 Vue `reactive`。

职责：

- 接收入站动作消息
- 与 `turn_id`、音频起播、pending 队列协同
- 调播放器
- 暴露调试状态

## 模块结构

建议新增目录：

```text
frontend/src/model-engine/
├─ contracts.ts
├─ constants.ts
├─ normalize.ts
├─ timing.ts
├─ supplementary.ts
├─ compiler.ts
├─ player.ts
├─ scheduler.ts
└─ useModelEngine.ts
```

职责：

- `contracts.ts`：定义 `MotionIntent`、`CompileOptions`、`CompileResult`、`PlaybackJob`
- `constants.ts`：12 轴常量、默认阈值、默认 timing 参数
- `normalize.ts`：兼容解析 `engine.motion_intent.v1` 与 `engine.parameter_plan.v1`
- `timing.ts`：`duration_hint_ms -> DirectParameterPlanTiming`
- `supplementary.ts`：从 `parameter_action_library` / `base_action_library` 推 supplementary
- `compiler.ts`：`MotionIntent -> DirectParameterPlan`
- `player.ts`：封装现有 `usePreviewMotionPlayer` 的执行接口
- `scheduler.ts`：pending plan、等音频起播、fallback timer、turn gating
- `useModelEngine.ts`：前端唯一对外入口

## 数据契约

### MotionIntent

```ts
interface MotionIntent {
  schema_version: "engine.motion_intent.v1";
  mode: "idle" | "expressive";
  emotion_label: string;
  duration_hint_ms?: number;
  key_axes: Record<DirectParameterAxisName, { value: number }>;
  summary?: {
    key_axes_count?: number;
  };
}
```

### 兼容输入

过渡期 `ModelEngine` 必须同时接受：

- `engine.motion_intent.v1`
- `engine.parameter_plan.v1`

规则：

- 收到 `motion_intent` 时，先编译再执行
- 收到现有 `parameter_plan` 时，直接走执行链路

这样前端可以先落地，后端后续再切 schema。

### CompileOptions

```ts
interface CompileOptions {
  model: ModelSummary;
  targetDurationMs?: number | null;
  source?: string;
}
```

### CompileResult

```ts
interface CompileResult {
  ok: boolean;
  plan: DirectParameterPlan | null;
  reason: string;
  diagnostics: {
    usedFallbackLibrary: boolean;
    supplementaryCount: number;
    timingSource: "hint" | "audio_sync" | "default";
  };
}
```

## 编译规则

### 1. 输入校验

- 前端输入必须包含完整 12 轴
- 轴值范围必须在 `0..100`
- `mode` 只允许 `idle | expressive`
- `emotion_label` 必须存在且非空
- `duration_hint_ms` 可缺失，缺失时使用前端默认 timing
- 缺必填字段、非法类型、非法 schema 必须 warning + reject，不能静默补 neutral、50 或空 supplementary 来掩盖错误
- 后端允许在 intent 归一化阶段对缺失轴 warning 后补 50；补齐后的完整 intent 才能进入前端

### 2. timing 生成

来源优先级：

1. 当前轮次剩余音频时长
2. `duration_hint_ms`
3. 默认值

规则：

- `idle`：短 blend、长 hold
- `expressive`：按比例拆分 `blend_in / hold / blend_out`
- 播放总时长允许被音频剩余时长覆盖
- 必须对齐旧后端 `_build_plan_timing()` 的有效时长边界，除非在代码和文档中说明新的前端策略

### 3. calibration 使用策略

`ModelEngine` 只做编译期可判定的安全处理，不替代 `lappmodel` 的最终执行态 calibration。

编译期职责：

- 读取 `model.calibration_profile`
- supplementary 选参时跳过明显不安全的参数
- 将 `model_calibration_profile` 挂入最终 plan

执行期职责仍保留在 `lappmodel.ts`：

- 轴方向翻转
- baseline / recommended_range / observed_range 应用
- 实际参数区间映射

结论：

- `ModelEngine` 负责“使用 calibration 做选择”
- `lappmodel` 负责“使用 calibration 做执行”
- 最终 plan 必须携带 `model_calibration_profile`，否则执行层无法按模型扫描结果映射参数

### 4. supplementary 推导

来源优先级：

1. `parameter_action_library`
2. `base_action_library`

规则：

- 优先按 channel 精确匹配
- 无精确结果时允许 relaxed fallback
- 不得与主轴绑定参数重叠
- 不得重复 parameter
- 无安全结果时允许返回空数组
- 必须迁移旧后端 `_build_supplementary_params()` 的关键行为：
- 按轴偏移幅度选择候选参数
- `parameter_action_library` 优先，`base_action_library` 只作为回退
- 使用 calibration/profile 中的轴绑定信息避让主轴参数
- 对候选参数做 polarity / semantic_polarity 匹配
- 限制 supplementary 最大数量
- 计算 `target_value` 与 `weight` 时保留“动作幅度越大，辅助参数越明显”的关系

### 5. expressive floor

旧后端 selector normalization 会对非 neutral 情绪做低幅度增强，避免模型输出几乎全 50 导致无动作。

前端迁移后有两种可选方案：

- 后端继续在 selector -> intent 阶段做 expressive floor，前端只消费增强后的 intent。
- 前端在 `compiler.ts` 中实现 expressive floor，后端只做严格解析。

无论选择哪一种，都必须保证非 neutral 情绪不会因为 12 轴接近 50 而被静默编译成无动作。若判定为 idle，必须有明确日志和 diagnostics。

### 6. plan 输出

输出保持兼容当前运行时：

- `schema_version = engine.parameter_plan.v1`
- `mode`
- `emotion_label`
- `timing`
- `key_axes`
- `supplementary_params`
- `model_calibration_profile`

过渡期不要求修改 `lappmodel` 的 plan schema。

## 后端旧编译器迁移对照

迁移时按下表逐项关闭后端职责，不能只做协议名切换。

| 旧后端能力 | 旧位置 | 前端目标位置 | 验收要求 |
| --- | --- | --- | --- |
| intent/selector 轴校验 | `normalize_motion_intent_payload` / `validate_motion_intent_payload` | `normalize.ts` | 后端缺轴 warning 补 50；前端缺轴、越界、非法类型拒绝 |
| idle deadzone 判定 | `build_plan_from_axes` | `compiler.ts` | 全轴在 deadzone 内输出 idle |
| timing 构造 | `_build_plan_timing` | `timing.ts` | hint/default/audio-sync 均覆盖 |
| calibration 挂载 | `_build_execution_calibration_profile` | `compiler.ts` + `lappmodel.ts` | plan 携带 `model_calibration_profile` |
| parameter library supplementary | `_build_supplementary_params` | `supplementary.ts` | 优先 parameter action atom |
| base library 回退 | `_build_supplementary_params(... allow_relaxed_matching=True)` | `supplementary.ts` | parameter 无结果时回退 base |
| 主轴参数避让 | `_KEY_AXIS_EXCLUDED_PARAMETER_IDS` + calibration | `supplementary.ts` | supplementary 不写主轴参数 |
| target/weight 计算 | `_build_supplementary_params` | `supplementary.ts` | 幅度越大 target/weight 越明显 |
| 播放重定时 | `PetDesktopView` / player retime | `useModelEngine.ts` + `timing.ts` | 动作跟随音频起播和剩余时长 |
| 错误暴露 | 后端 warning/error | `normalize.ts` / `useModelEngine.ts` / player | 不静默补默认值 |

## 调度模型

`ModelEngine` 应把当前 `PetDesktopView.vue` 中的 pending 计划逻辑收进去。

### 输入事件

- `ingestInboundMotionPayload(payload, turnId, receivedAtMs)`
- `notifyAudioPlaybackStarted(turnId, startedAtMs, durationMs)`
- `notifyTurnInterrupted(turnId)`
- `notifyModelChanged(model)`

### 调度规则

- 同一 `turn_id` 新 plan 覆盖旧 pending plan
- 若音频已开始且 turn 匹配，立即编译并起播
- 若音频未开始，进入 pending 并等待
- 超过等待窗口后无音频则走超时兜底
- 若当前 `turn_id` 已切换，则丢弃旧 pending

## 与现有文件的关系

### 保留不动

- `frontend/src/live2d/WebSDK/src/lappmodel.ts`
- `frontend/src/live2d/WebSDK/src/lappadapter.ts`
- `frontend/src/composables/useModelSync.ts`

### 收缩

- `frontend/src/composables/usePreviewMotionPlayer.ts`

计划：

- 保留真正的播放器能力
- 把以下逻辑迁出到 `model-engine/`
  - schema 兼容解析
  - calibration 归一化工具
  - 纯 plan 归一化

### 迁移

- `frontend/src/views/PetDesktopView.vue`

计划：

- 移除 pending inbound motion plan 相关状态与定时器
- 改为调用 `useModelEngine()`

### 轻改

- `frontend/src/composables/useAdapterConnection.ts`

计划：

- 继续接收 `engine.motion_plan`
- 后续增加 `engine.motion_intent` 时只需扩展 case
- 入站动作消息仍先进入 connection state，再交给 `ModelEngine`

## useModelEngine API

建议对外只暴露一套接口：

```ts
const modelEngine = useModelEngine();

modelEngine.ingestInboundPayload(payload, { turnId, receivedAtMs });
modelEngine.notifyAudioPlaybackStarted({ turnId, startedAtMs, durationMs });
modelEngine.stop(reason);
modelEngine.playPreviewIntent(intent, selectedModel);
modelEngine.playPreviewPlan(plan, selectedModel);
```

只读状态：

```ts
modelEngine.state.status
modelEngine.state.message
modelEngine.state.pendingTurnId
modelEngine.state.lastCompileReason
modelEngine.state.lastCompileDiagnostics
```

## 第一阶段实现范围

先实现能落地的闭环，但每一阶段都要保留“最终必须完整迁移旧后端编译器”的对照清单。任何临时简化都要在 diagnostics 或文档里明确标注，不能被当成完成态。

### Phase 1

- 新增 `frontend/src/model-engine/`
- 定义 `contracts.ts`
- 实现 `normalize.ts`
- 实现 `timing.ts`
- 实现 `compiler.ts`
- `compiler.ts` 先支持 `MotionIntent -> DirectParameterPlan`
- supplementary 如先走最小版本，必须保留 TODO 和 diagnostics，后续 Phase 不能跳过完整迁移

### Phase 2

- 实现 `scheduler.ts`
- 实现 `useModelEngine.ts`
- 将 `PetDesktopView.vue` 的 pending 逻辑迁入 `ModelEngine`
- 接入音频起播、无音频超时、stale turn 丢弃

### Phase 3

- 收缩 `usePreviewMotionPlayer.ts`
- 将纯函数工具迁到 `model-engine/`
- 保留播放器与运行时桥接
- 清理播放器和 `lappmodel.ts` 中对必填字段的静默默认值

### Phase 4

- 前端同时兼容 `engine.parameter_plan.v1` 与 `engine.motion_intent.v1`
- 后端再切到只下发 intent
- debug / preview 从 `motion_plan` 命名迁到 motion payload 命名

### Phase 5

- 按“后端旧编译器迁移对照”补齐前端实现和测试。
- 确认生产路径不再调用后端 `build_plan_from_axes()`。
- 删除或归档后端旧 plan 编译测试，替换为前端 ModelEngine 测试。
- 更新文档和 README，标记后端正式收口到 motion intent。

## 测试要求

新增单测目录建议：

```text
frontend/src/model-engine/__tests__/
├─ normalize.spec.ts
├─ timing.spec.ts
├─ compiler.spec.ts
└─ scheduler.spec.ts
```

必测项：

- 前端收到 12 轴缺失时拒绝编译；后端 intent 归一化阶段应先 warning 补 50
- `emotion_label` 缺失时拒绝编译
- `duration_hint_ms` 与音频剩余时长优先级
- `parameter_action_library` 无结果时回退 `base_action_library`
- supplementary 去重与避让 axis parameter
- supplementary target/weight 随轴幅度变化
- 非 neutral 低幅度 intent 的处理策略
- stale turn 丢弃
- audio wait timeout 兜底
- 兼容旧 `engine.parameter_plan.v1`
- legacy plan 绕过 ModelEngine 时，底层播放器仍要拒绝缺必填字段

## 风险

- supplementary 推导迁移到前端后，短期内效果可能与后端版本不完全一致
- 若把过多逻辑继续留在 `usePreviewMotionPlayer.ts`，会导致 `ModelEngine` 只是换名字没有真正收口
- 若把 calibration 执行逻辑重复搬进 `compiler.ts`，会与 `lappmodel.ts` 产生双重映射风险

## 当前建议

- 第一版可以先保留 `lappmodel.ts` schema，但不能保留必填字段静默默认。
- 第一版可以保留 legacy `engine.motion_plan` 兼容，但新主路径必须是 `engine.motion_intent`。
- 第一版先让前端能吃 `MotionIntent`，随后立即补齐旧后端编译器迁移对照。
- supplementary 不能长期停留在“结构正确 + 基础可用”，迁移完成标准是承接旧后端候选选择、回退、避让和权重计算能力。
