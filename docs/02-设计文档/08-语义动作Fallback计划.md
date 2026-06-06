# 语义动作 fallback 计划

## 目标

本计划描述 AG99live 后续动作生成链路的目标形态：一次 AstrBot 请求同时产出用户可见文本和动作语义结果。动作结果优先使用 LLM 生成的语义轴参数；当参数不可用时，使用同一 prompt 中提供的代表性示例作为 fallback pose。

动作生成入口分为两条独立路线：

- `middleware-first`：面向 AG99live 当前修改过的 AstrBot，使用 interaction middleware 的 `plugin_hints` / `client_objects` 主链路。
- `inline_first`：面向未改造的官方 AstrBot，使用主回复文本末尾的 `<@anim ...>` 兼容契约。

两条路线代表两套不同的 AstrBot 接入能力，不互相兜底、不交叉解析。系统应先按配置和运行环境判定当前路线，再执行对应路线的 prompt 注入、输出解析和 fallback 处理。两条路线只在最终输出 `engine.motion_intent.v2` 时汇合。

目标不是让前端或适配器改为播放录制 motion，也不是让 LLM 直接操作 Live2D 底层参数文件。主链路仍保持：

```text
AstrBot / Adapter 生成 engine.motion_intent.v2
  -> Frontend ModelEngine 编译为 engine.parameter_plan.v2
  -> Live2D runtime 执行参数计划
```

## 核心结论

- LLM 的职责是：在当前路线规定的结构中生成一组语义动作轴，并选择一个 `fallback_pose_id`；用户可见文本由该路线自己的回复通道承载。
- `fallback_pose_id` 指向 prompt 中提供的代表性语义姿态示例，不直接播放 Live2D `.exp3.json` 表情或 motion3 动画；id 命名可以参考已有动作/表情资源名，fallback 本体仍是语义轴输出。
- `duration_ms` 和 `axes` 允许存在可修复错误；适配器先归一化和修复，再判断是否需要 fallback。LLM 主输出应尽量给出 5 到 8 个相关轴，repair 后至少保留 3 到 4 个有效轴，才视为可用动作。
- 自动 fallback 不再进入 catalog motion / expression 路线；目标方案逐步抛弃固定 motion3 模板和固定表情模板，把动作系统收敛到语义轴和 fallback pose 示例。
- 前端仍只接收标准 `engine.motion_intent.v2`，不需要知道 payload 来自 LLM 原始输出还是 fallback 示例。
- `middleware-first` 和 `inline_first` 的解析链路必须隔离：middleware-first 不解析 `<@anim>`；inline_first 不依赖 interaction `plugin_hints`。

## 路线选择

动作链路启动前先解析 `motion_generation_mode` 或等价运行态能力：

```text
motion_generation_mode == "split_after_reply"
  -> middleware-first

motion_generation_mode == "inline_first"
  -> inline_first
```

如果运行环境没有 interaction middleware / `plugin_hints` 能力，官方 AstrBot 兼容部署应显式使用 `inline_first`。如果运行环境具备 AG99live interaction contributors，默认使用 `middleware-first`。

路线选择完成后，本轮只执行选中的路线：

- 不因为 middleware-first 的 `plugin_hints` 缺失而回头解析 assistant 文本里的 `<@anim>`。
- 不因为 inline_first 的标签缺失而读取 interaction `plugin_hints`。
- 两条路线共享 fallback pose registry、normalize / repair 规则、最终 `engine.motion_intent.v2` 封装逻辑。

## 请求上下文

无论走哪条路线，注入给 LLM 的动作上下文都应包含：

- 当前 Live2D 模型身份：
  - `model_id`
  - `profile_id`
  - `profile_revision`
- 当前模型可控制语义轴：
  - axis id
  - 语义解释
  - 取值范围
  - 中性值
  - 低值 / 高值含义
  - 使用约束
- 代表性 fallback pose 示例：
  - `id`
  - `label`
  - `emotion`
  - `mode`
  - `duration_ms`
  - `axes`
  - 简短场景说明
- 输出格式要求：
  - 当前路线对应的 motion 结构
  - 必填 `fallback_pose_id`

## Middleware-first 输出形态

`middleware-first` 是 AG99live 当前默认主路径。动作内容必须进入 interaction decision 的 `plugin_hints.ag99live_motion`，不要写入用户可见文本、`immediate_spoken_reply` 或 `core_task_spec`。

目标结构：

```json
{
  "plugin_hints": {
    "ag99live_motion": {
      "choice": "generate",
      "emotion_label": "happy",
      "mode": "expressive",
      "duration_hint_ms": 1000,
      "fallback_pose_id": "happy_smile_sway",
      "axes": {
        "head_pitch": { "value": 62 },
        "head_roll": { "value": 58 },
        "body_roll": { "value": 59 },
        "mouth_smile": { "value": 84 }
      }
    }
  }
}
```

`AG99liveMotionResultContributor` 从 `_interaction_plugin_hints` 读取该对象，执行 normalize / repair / fallback，然后生成 `client_objects`，最终由 turn coordinator 广播 `engine.motion_intent`。

## Inline-first 输出形态

`inline_first` 是官方 AstrBot 兼容路径。动作内容必须写在 assistant 主回复末尾的 `<@anim ...>` 标签中，adapter 负责剥离标签并提取 motion。该路线不依赖 interaction `plugin_hints`。

目标结构：

```text
给用户看的自然语言回复。

<@anim {"mode":"inline","intent":{"schema_version":"engine.motion_intent.v2","emotion_label":"happy","mode":"expressive","duration_hint_ms":1000,"fallback_pose_id":"happy_smile_sway","axes":{"head_pitch":{"value":62},"mouth_smile":{"value":84}}}}>
```

inline 兼容路径可以继续使用现有 `<@anim>` 解析器，但需要扩展 `intent` 支持 `fallback_pose_id`，并复用同一套 normalize / repair / fallback resolver。

## Fallback Pose 示例结构

现有 fixed few-shot 示例可以升级为带稳定 id 的 fallback pose：

```json
{
  "id": "happy_smile_sway",
  "label": "开心微笑轻晃",
  "emotion": "happy",
  "mode": "expressive",
  "description": "正向反馈、满意或轻松调侃时使用。",
  "duration_ms": 1000,
  "axes": {
    "head_pitch": 62,
    "head_roll": 58,
    "body_roll": 59,
    "body_pitch": 61,
    "eye_smile_left": 78,
    "eye_smile_right": 78,
    "mouth_smile": 84
  }
}
```

这些示例同时服务两个目的：

- prompt 中作为代表性动作风格样本，帮助 LLM 理解语义轴如何组合。
- 运行时作为 fallback pose 库，在 LLM 生成参数不可用时直接转成 `engine.motion_intent.v2`。

为了避免 LLM 偷懒照抄，prompt 应明确：

- `fallback_pose_id` 必须从列表中选择。
- `fallback_pose_id` 只是兜底选项，不代表主动作应该照抄示例。
- 主动作仍应根据本轮回复生成合适的 `axes`，目标是 5 到 8 个相关轴，而不是只给 1 到 2 个弱表情轴。

## 归一化与修复规则

适配器收到当前路线的 motion 后先执行 normalize / repair，而不是立即 fallback。

路线只决定 motion 从哪里来：

- middleware-first：从 `plugin_hints.ag99live_motion` 来。
- inline_first：从 `<@anim ...>.intent` 来。

normalize / repair 之后的处理规则完全相同。

### 可修复错误

这些情况修复后仍使用 LLM 生成结果：

- `duration_ms` 缺失：使用默认时长 `1000ms`。
- `duration_ms` 不是数字但可转数字：转成整数。
- `duration_ms` 太短或太长：夹到允许范围。
- `axes` 可以接受两种输入形态：
  - 推荐形态：`{"head_pitch":{"value":62}}`
  - 容错形态：`{"head_pitch":62}`
  两者都归一化为 `engine.motion_intent.v2` 需要的 `{"axis_id":{"value":number}}`。
- 已知轴值越界：按该轴范围 clamp。
- 轴值是字符串数字：转成数字。
- 少量未知轴：丢弃未知轴，保留合法轴。
- 单个 axis payload 如果缺少 `value`、`value` 不可转数字，或 axis id 为空，则只丢弃该轴，不影响其他轴。
- `axes` 修复后必须保留足够的合法轴，才继续使用 LLM 生成结果，不进入 fallback。默认最低要求为 3 个合法轴；`expressive` 或明确情绪动作优先要求至少 4 个合法轴。
- `emotion_label` 缺失：可用 `fallback_pose_id` 对应示例的 emotion 或 `neutral` 补齐。

### Axes 修复细则

`axes` 是本方案最重要的可修复字段。实现时应按轴逐个修复，而不是把整个 `axes` 作为一个全有全无的对象。LLM 输出的主动作应包含足够动作骨架：通常 5 到 8 个相关轴，至少覆盖头部、身体、眼部/视线、表情细节中的多个维度。修复后如果只剩 1 到 2 个合法轴，应视为动作表达不足并进入 fallback pose。

输入示例：

```json
{
  "head_pitch": 62,
  "mouth_smile": { "value": "84" },
  "unknown_axis": 70,
  "body_roll": { "value": 130 }
}
```

在当前模型 profile 中如果 `head_pitch`、`mouth_smile`、`body_roll` 是合法轴，且范围为 `0..100`，应修复为：

```json
{
  "head_pitch": { "value": 62 },
  "mouth_smile": { "value": 84 },
  "body_roll": { "value": 100 }
}
```

其中：

- `head_pitch: 62` 被包装为 `{ "value": 62 }`。
- `mouth_smile.value: "84"` 被转成数字。
- `unknown_axis` 被丢弃。
- `body_roll.value: 130` 被 clamp 到该轴最大值。

轴范围以 `SemanticAxisProfile` 中对应 axis 的 `value_range` 为准。实现和 prompt 都不要硬编码所有轴一定是 `0..100`，因为模型 profile 可能引入 `-100..100` 等范围。若某个 axis 在当前 `SemanticAxisProfile` 中不存在，或缺少可用范围，该轴不可修复，应丢弃。

有效轴数量判定：

- `idle`：修复后至少保留 3 个合法轴，推荐 4 到 6 个。
- `expressive`：修复后至少保留 4 个合法轴，推荐 5 到 8 个。
- 如果合法轴数量不足，即使这些轴本身可修复，也应使用 `fallback_pose_id` 对应的代表性示例。
- 只输出嘴角、眉毛等少量表情细节而缺少头部/身体/视线骨架时，也应视为动作表达不足。

### 不可修复错误

这些情况使用 fallback pose：

- motion JSON 结构无法解析。
- `axes` 缺失、为空，或修复后合法轴数量不足。
- `mode` 不合法且无法推断。
- `profile_id` / `model_id` / `profile_revision` 与当前模型身份冲突。
- `fallback_pose_id` 之外的字段足以说明动作意图失败。

### Fallback 选择

fallback 顺序：

```text
LLM axes 修复后达到最低有效轴数量
  -> 使用 LLM 生成结果
否则查 fallback_pose_id
  -> 命中则使用对应示例
否则
  -> 使用默认 neutral fallback pose
```

fallback pose 生成的最终 payload 仍是：

```json
{
  "schema_version": "engine.motion_intent.v2",
  "profile_id": "...",
  "profile_revision": 1,
  "model_id": "...",
  "mode": "expressive",
  "emotion_label": "happy",
  "duration_hint_ms": 1000,
  "axes": {
    "head_pitch": { "value": 62 }
  }
}
```

## 协议边界

前端协议不需要新增新的 motion 类型。后端继续广播：

```text
type: engine.motion_intent
payload.intent.schema_version: engine.motion_intent.v2
```

可以在 payload 的 `summary` 或 diagnostics 中记录来源：

```json
{
  "summary": {
    "axis_count": 4,
    "fallback_pose_id": "happy_smile_sway",
    "fallback_used": true,
    "repair_warnings": [
      "duration_ms_clamped",
      "unknown_axis_dropped:tail_swing"
    ]
  }
}
```

这些诊断字段只用于调试和调参，不应成为前端播放必需字段。

两条路线在这里汇合：

```text
middleware-first plugin_hints
  -> normalize / repair / fallback
  -> engine.motion_intent.v2

inline_first <@anim>
  -> normalize / repair / fallback
  -> engine.motion_intent.v2
```

除这个统一出口外，两条路线不共享解析入口。

## 与现有 catalog motion 的关系

当前 motion selector prompt 已支持 `choice=catalog`，并且后端和前端也存在 `engine.catalog_motion` 路径。但这属于历史能力，不再作为目标动作路线继续扩展。

目标方向：

- 删除自动选择 catalog motion 的 prompt 诱导，不再让 LLM 输出 `choice=catalog`。
- 后端自动动作生成只产出 `engine.motion_intent.v2`。
- fallback pose 也是语义轴示例，不是录制 motion 或 `.exp3.json` 表情。fallback id 可以参考表情/动作资源名命名，但本计划主要选用表情侧可抽象出的稳定姿态，不使用动画模板作为 fallback。
- 现有 `engine.catalog_motion` 路径后续只作为迁移期遗留代码处理，不参与本方案。

理由：

- 固定 motion3 / expression 模板会把系统带回素材选择器，而不是语义参数驱动。
- catalog motion 会走 `startMotion()`，它当前存在 pending / failed 返回语义混淆问题。
- 语义 fallback pose 仍走 `engine.motion_intent.v2 -> parameter_plan`，与主链路一致。
- fallback 行为更可控，不需要在参数系统失败后切到另一套播放语义。

后续实现时，应把 catalog motion 从自动动作 prompt 和自动 fallback 里移除。现有手动调试入口如果仍依赖它，应单独评估是否删除、隐藏或迁移成语义轴示例生成工具。

## 实施步骤

1. 明确路线选择：
   - `split_after_reply` / interaction contributors -> middleware-first。
   - `inline_first` / 官方 AstrBot 兼容部署 -> inline_first。
2. 给 fixed few-shot 示例补稳定 `id`、`label`、`description`，形成 fallback pose registry。
3. 在 middleware-first prompt contributor 中注入 fallback pose 列表，并要求 `plugin_hints.ag99live_motion.fallback_pose_id`。
4. 在 inline_first contract 中注入同一套 fallback pose 列表，并要求 `<@anim>.intent.fallback_pose_id`。
5. 扩展 middleware-first 的 plugin hints 解析，读取 `fallback_pose_id`。
6. 扩展 inline_first 的 `<@anim>` 解析，读取 `fallback_pose_id`。
7. 新增共享 motion normalize / repair 层：
   - 修复 duration。
   - clamp 已知轴。
   - 丢弃未知轴。
   - 记录 repair warnings。
8. 新增共享 fallback resolver：
   - 优先按 `fallback_pose_id` 查找。
   - 查不到时回退默认 neutral pose。
9. 保持 WebSocket 出站 payload 为 `engine.motion_intent.v2`。
10. 更新测试，覆盖双路线主生成、可修复错误、fallback 命中、fallback id 无效和默认 neutral。

## 测试计划

- prompt 构建测试：
  - middleware-first 的 `plugin_hints_format` 注入 fallback pose id。
  - inline_first 的 `<@anim>` contract 注入 fallback pose id。
  - 两条路线的输出格式要求都包含 `fallback_pose_id`。
  - 示例仍说明不要机械照抄。
- normalize / repair 测试：
  - duration 缺失时补默认值。
  - duration 越界时 clamp。
  - 轴值字符串数字可转。
  - 已知轴越界时 clamp。
  - 未知轴被丢弃。
  - 修复后达到最低有效轴数量时不 fallback。
  - 修复后只剩 1 到 2 个合法轴时进入 fallback。
- fallback resolver 测试：
  - axes 为空时使用 `fallback_pose_id`。
  - `fallback_pose_id` 无效时使用默认 neutral。
  - fallback 结果仍是合法 `engine.motion_intent.v2`。
- 路线隔离测试：
  - middleware-first 缺失 plugin hints 时不解析 assistant 文本 `<@anim>`。
  - inline_first 缺失 `<@anim>` 时不读取 interaction plugin hints。
  - 两条路线最终广播的都是 `engine.motion_intent`。
- 回归测试：
  - interaction motion contributor 单测。
  - realtime motion selector 单测。
  - turn coordinator motion broadcast 单测。
  - 前端 `normalizeMotionPayload` / ModelEngine 相关测试。

## 非目标

- 不让 LLM 直接输出 Live2D 原始参数名或底层 `.exp3.json` 表情文件。
- 不把 catalog motion / expression 作为自动 fallback，也不继续把它作为目标动作生成选项扩展。
- 不改变前端 text / audio / motion 的 turn segment 同步编排。
- 不新增前端 motion 协议类型。
- 不把 middleware-first 和 inline_first 做成互相 fallback。
- 不在本计划中修复 catalog motion `startMotion()` 返回值语义问题；目标路线会逐步避开该路径。

## 已确认设计决策

- 默认 duration 统一使用 `1000ms`。
- 每个轴的范围完全以 `SemanticAxisProfile` 为准，不做全局统一范围假设。
- fallback pose id 命名参考已有动作/表情资源名；实际 fallback 主要选用表情侧可抽象出的稳定姿态，不使用动画模板。
- 字段名统一为 `fallback_pose_id`。
- `fallback_pose_id` 在 middleware-first 中放入 `plugin_hints.ag99live_motion`；在 inline_first 中放入 `<@anim>.intent`。
