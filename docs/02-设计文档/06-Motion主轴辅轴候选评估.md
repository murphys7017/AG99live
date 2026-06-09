# Motion 主轴/辅轴候选评估表

本文记录当前基于 Mk6_1.0 `Motions/*.motion3.json` 的动作轴候选评估。

目标不是修改引擎，而是把“哪些参数适合成为动作主轴，哪些适合作为面部辅轴”整理成证据表，用于维护 `SemanticAxisProfile` 默认生成策略、prompt 和调参工具展示。

## 1. 当前设计口径

```text
动作主轴 = 姿态和动作骨架，负责动作轮廓、方向、强弱、节奏感
表情辅轴 = 面部表情和态度细节，负责嘴角、眉毛、视线等微调
运行时轴 = 说话口型、呼吸、持续驱动等运行时控制
不建议暴露 = 表达式开关、物理跟随、装饰/特效/衣物辅助参数
```

当前目标规模：

```text
动作主轴：约 10-20 个
表情辅轴：约 5-6 个
运行时轴：少量，由 runtime 或 lip sync 优先管理
```

## 2. Motion 证据摘要

统计口径：

- 扫描 `astrbot_plugin_ag99live_adapter/live2ds/Mk6_1.0/Motions/*.motion3.json`
- 只统计 `Target === "Parameter"` 曲线
- `motion_count` 表示有实际变化的 motion 数量
- `avg_amp` 表示该候选轴在出现 motion 中的平均参数变化幅度
- `max_amp` 表示最大变化幅度
- `strongest_motions` 只列出变化最强的代表动作

| axis | params | motion_count | avg_amp | max_amp | strongest_motions |
| --- | --- | ---: | ---: | ---: | --- |
| `head_yaw` | `ParamAngleX` | 23 | 14.53 | 42.50 | 生气 42.50<br>不耐烦前倾 32.00<br>惊讶后缩 31.25<br>左右晃动 30.76 |
| `head_roll` | `ParamAngleZ` | 23 | 14.47 | 48.59 | 左右晃动 48.59<br>困惑歪头 32.33<br>生气 31.97<br>开心点亮 24.02 |
| `head_pitch` | `ParamAngleY` | 23 | 10.43 | 35.26 | 感到舒适 35.26<br>生气 30.73<br>疲惫哈欠 18.96<br>左右晃动 14.69 |
| `body_roll` | `ParamBodyAngleZ` | 22 | 4.87 | 14.25 | 左右晃动 14.25<br>生气 11.16<br>困惑歪头 10.51<br>开心点亮 8.23 |
| `body_yaw` | `ParamBodyAngleX` | 22 | 4.57 | 13.99 | 生气 13.99<br>左右晃动 10.95<br>不耐烦前倾 9.73<br>惊讶后缩 9.15 |
| `body_pitch_candidate` | `BodyAngleY` / `PhyBodyPositionY` | 22 | 4.05 | 13.54 | 疲惫哈欠 13.54<br>害羞躲闪 9.78<br>开心点亮 7.21<br>失落下垂 6.56 |
| `brow_left_detail` | `ParamBrowLDown` / `ParamBrowLOutterUp` | 10 | 2.42 | 20.16 | 温和摇晃 20.16<br>失落下垂 0.94<br>疲惫哈欠 0.85<br>害羞躲闪 0.76 |
| `gaze_x` | `ParamEyeBallX` | 23 | 1.31 | 3.06 | 疲惫哈欠 3.06<br>温和点头 2.40<br>思考停顿 2.19<br>害羞躲闪 2.15 |
| `gaze_y` | `ParamEyeBallY` | 23 | 1.09 | 5.06 | 失落下垂 5.06<br>惊讶后缩 3.22<br>害羞躲闪 2.14<br>微笑左偏头 1.47 |
| `breath` | `ParamBreath` | 23 | 1.04 | 1.43 | 怀疑眯眼 1.43<br>困惑歪头 1.43<br>微笑左偏头 1.41<br>平和 1.20 |
| `eye_open_left` | `ParamEyeLOpen` / `PhyEyeLOpen` | 23 | 0.92 | 1.40 | 微笑眨眼右偏 1.40<br>感到舒适 1.37<br>开心轻晃 1.34<br>歪头坏笑 1.32 |
| `eye_open_right` | `ParamEyeROpen` / `PhyEyeROpen` | 23 | 0.90 | 1.40 | 微笑左偏头 1.40<br>歪头坏笑 1.39<br>感到舒适 1.34<br>微笑眨眼右偏 1.34 |
| `brow_right_detail` | `ParamBrowRDown` / `BrowRInnerUp` / `BrowROutterUp` | 9 | 0.53 | 1.04 | 失落下垂 1.04<br>微笑 0.91<br>疲惫哈欠 0.84<br>害羞躲闪 0.81 |
| `mouth_smile` | `ParamMouthForm` / `PhyMouthForm` | 23 | 0.45 | 1.09 | 微笑 1.09<br>开心点亮 1.05<br>歪头坏笑 1.01<br>微笑眨眼右偏 0.87 |
| `mouth_x` | `ParamMouthX` / `PhyMouthX` | 23 | 0.41 | 1.61 | 开心点亮 1.61<br>微笑左偏头 0.58<br>生气 0.57<br>惊讶后缩 0.54 |
| `mouth_open` | `ParamMouthOpenY` / `ParamJawOpen` / `PhyJawOpen` | 23 | 0.32 | 1.29 | 惊讶 1.29<br>疲惫哈欠 1.09<br>生气 0.65<br>开心点亮 0.59 |
| `eye_smile_left` | `ParamEyeLSmile` | 23 | 0.26 | 1.25 | 歪头坏笑 1.25<br>开心点亮 1.18<br>微笑 0.91<br>生气 0.34 |
| `eye_smile_right` | `ParamEyeRSmile` | 23 | 0.26 | 1.25 | 歪头坏笑 1.25<br>开心点亮 1.18<br>微笑 0.91<br>生气 0.34 |
| `brow_bias` | `ParamBrowForm` | 14 | 0.25 | 1.22 | 开心点亮 1.22<br>歪头坏笑 1.19<br>疲惫哈欠 0.24<br>开心轻晃 0.21 |

## 3. 轴候选分组

### 3.1 确定动作主轴

| axis_id | 参数 | 说明 | 建议 |
| --- | --- | --- | --- |
| `head_yaw` | `ParamAngleX` | 最强、最稳定的头部左右方向轴 | 保留主轴 |
| `head_pitch` | `ParamAngleY` | 低头、抬头、点头、压迫感和下垂感核心轴 | 保留主轴 |
| `head_roll` | `ParamAngleZ` | 歪头、摇晃、困惑、调侃的核心轴 | 保留主轴 |
| `body_yaw` | `ParamBodyAngleX` | 身体左右扭转，配合头部表达情绪力度 | 升为主轴或强主轴候选 |
| `body_roll` | `ParamBodyAngleZ` | 身体左右倾斜和摇晃，motion 证据稳定 | 升为主轴或强主轴候选 |
| `eye_open_left` | `ParamEyeLOpen` | 眨眼、疲惫、惊讶、害羞的动作成立条件 | 保留主轴 |
| `eye_open_right` | `ParamEyeROpen` | 同左眼，支持对称或非对称眼部动作 | 保留主轴 |

### 3.2 候选动作主轴

| axis_id | 参数候选 | 说明 | 风险 |
| --- | --- | --- | --- |
| `body_pitch` / `body_lift` / `body_depth` | `BodyAngleY`、`PhyBodyPositionY`、`PhyBodyUpperY`、`PhyBodyLowerY` | 表达前倾、后缩、下沉、挺起、低能量姿态 | `Phy*` 可能是物理跟随，不适合直接主控；需优先确认 `BodyAngleY` |
| `eye_smile_left` | `ParamEyeLSmile` | 眼睛笑意、眯眼、调侃可用 | 幅度小，可能更像表情辅轴 |
| `eye_smile_right` | `ParamEyeRSmile` | 同左眼笑意 | 幅度小，可能更像表情辅轴 |
| `gaze_x` | `ParamEyeBallX` | 视线左右，害羞躲闪、思考、疲惫有用 | 也可作为表情辅轴，不能过度主导动作 |
| `gaze_y` | `ParamEyeBallY` | 视线上下，低落、回避、惊讶有用 | 也可作为表情辅轴，需和 head_pitch 配合 |

### 3.3 确定表情辅轴

| axis_id | 参数 | 说明 | 建议 |
| --- | --- | --- | --- |
| `mouth_smile` | `ParamMouthForm` | 嘴角笑意、委屈、不满、坏笑 | 辅轴 |
| `brow_bias` | `ParamBrowForm` | 整体眉毛倾向，疑惑、紧张、压眉 | 辅轴 |
| `gaze_x` | `ParamEyeBallX` | 视线态度，躲闪、观察、偏移 | 若不放主轴，至少保留辅轴 |
| `gaze_y` | `ParamEyeBallY` | 低头视线、抬眼、失落、惊讶 | 若不放主轴，至少保留辅轴 |
| `mouth_x` | `ParamMouthX` | 嘴部偏移，坏笑、歪嘴、表情不对称 | 候选辅轴 |

### 3.4 候选表情辅轴

| axis_id | 参数候选 | 说明 | 风险 |
| --- | --- | --- | --- |
| `brow_left_detail` | `ParamBrowLDown`、`ParamBrowLOutterUp` | 左眉细节，有些 motion 幅度很明显 | `ParamBrowLOutterUp` 在温和摇晃中异常高，需要确认是否是有效语义还是动画噪声 |
| `brow_right_detail` | `ParamBrowRDown`、`BrowRInnerUp`、`BrowROutterUp` | 右眉细节 | 右眉参数命名不统一，需确认可控范围 |
| `eye_smile_left` | `ParamEyeLSmile` | 眼睛笑意 | 可归辅轴 |
| `eye_smile_right` | `ParamEyeRSmile` | 眼睛笑意 | 可归辅轴 |

### 3.5 运行时轴

| axis_id | 参数 | 说明 | 建议 |
| --- | --- | --- | --- |
| `mouth_open` | `ParamMouthOpenY` / `ParamJawOpen` | 嘴巴开闭，说话口型、哈欠、惊讶会用到 | 说话时优先 runtime/lip sync；动作中可作为受控候选但需避开冲突 |
| `breath` | `ParamBreath` | 呼吸和身体起伏，全 motion 都有稳定证据 | 默认 runtime/ambient；不建议让 LLM 高频直控 |

### 3.6 不建议暴露给 LLM 主控

| 类型 | 例子 | 原因 |
| --- | --- | --- |
| `Anim*` | `AnimFlower`、`AnimSleeping*`、`AnimVibrate`、`AnimSurprise` | 多为动画/效果/开关或内部状态，幅度大但不等于语义主轴 |
| `Exp*` | `ExpHappy`、`ExpAngry`、`ExpFaceBlush` | 表达式叠加或作者预设触发，不作为主轴来源 |
| `Phy*` | `PhyAngleX`、`PhyBodyLowerX`、`PhyEyeLOpen` | 物理跟随或二级响应，可用于分析，不优先直接主控 |
| 衣物/饰品/肢体细碎参数 | `PhyTie*`、`PhyEarring*`、`ParamHairband*`、`ParamForearm*` | 更适合作为 motion 内部效果或高级动作层，不进入当前语义轴 |

## 4. 当前轴名单

本节记录当前比“全部候选”更收敛的一组轴，目标是保持稳定、可解释、便于调参。

### 4.1 当前动作主轴

当前动作主轴共 12 个。它们负责姿态、方向、动作强弱和注意力方向。

| axis_id | 建议参数 | role | 说明 | 落地状态 |
| --- | --- | --- | --- | --- |
| `head_yaw` | `ParamAngleX` | `primary` | 头部左右转，是最核心动作方向轴 | 第一版落地 |
| `head_pitch` | `ParamAngleY` | `primary` | 低头、抬头、点头、下垂、压迫感 | 第一版落地 |
| `head_roll` | `ParamAngleZ` | `primary` | 歪头、左右摇晃、困惑、调侃 | 第一版落地 |
| `body_yaw` | `ParamBodyAngleX` | `primary` | 身体左右扭转，表达情绪力度和姿态跟随 | 第一版落地 |
| `body_roll` | `ParamBodyAngleZ` | `primary` | 身体左右倾斜、摇晃、重心偏移 | 第一版落地 |
| `body_pitch` | 优先验证 `BodyAngleY` | `primary` | 前倾、后缩、下沉、挺起的第一候选轴 | 第一版候选落地，需预览确认 |
| `eye_open_left` | `ParamEyeLOpen` | `primary` | 左眼开闭，支撑眨眼、疲惫、惊讶 | 第一版落地 |
| `eye_open_right` | `ParamEyeROpen` | `primary` | 右眼开闭，支撑非对称眨眼和眼部状态 | 第一版落地 |
| `eye_smile_left` | `ParamEyeLSmile` | `primary` | 左眼笑意/眯眼，支撑开心、坏笑、怀疑 | 第一版落地 |
| `eye_smile_right` | `ParamEyeRSmile` | `primary` | 右眼笑意/眯眼，和左眼组合成眼部动作 | 第一版落地 |
| `gaze_x` | `ParamEyeBallX` | `primary` | 视线左右，表达躲闪、观察、注意力转移 | 第一版落地 |
| `gaze_y` | `ParamEyeBallY` | `primary` | 视线上下，表达低落、抬眼、惊讶和回避 | 第一版落地 |

说明：

- `body_pitch` 第一版只记录一个语义轴，不同时暴露 `body_lift/body_depth`，避免身体上下/前后拆得太碎。
- `body_pitch` 的参数优先验证 `BodyAngleY`。`PhyBodyPositionY`、`PhyBodyUpperY`、`PhyBodyLowerY` 暂时只作为 motion 证据，不优先直控。
- `gaze_x/gaze_y` 在第一版归入主轴，是因为目标主轴规模接近 10-20 个，且视线方向对动作轮廓和注意力表达很关键。
- `eye_smile_left/right` 第一版归入主轴，是因为它们能构成眯眼、笑眼、怀疑和坏笑的眼部动作，不只是微小装饰。

### 4.2 第一版表情辅轴

第一版表情辅轴共 5 个。它们负责在动作骨架上补充嘴角、眉毛和局部态度。

| axis_id | 建议参数 | role | 说明 | 落地状态 |
| --- | --- | --- | --- | --- |
| `mouth_smile` | `ParamMouthForm` | `hint` | 嘴角笑意、委屈、不满、坏笑 | 第一版落地 |
| `mouth_x` | `ParamMouthX` | `hint` | 嘴部左右偏移，支持歪嘴、坏笑、不对称表情 | 第一版落地 |
| `brow_bias` | `ParamBrowForm` | `hint` | 眉毛整体倾向，疑惑、紧张、压眉、抬眉 | 第一版落地 |
| `brow_left_detail` | 优先验证 `ParamBrowLDown` | `hint` | 左眉细节，支撑非对称表情 | 第一版候选落地，需预览确认 |
| `brow_right_detail` | 优先验证 `ParamBrowRDown` | `hint` | 右眉细节，和左眉组合表情态度 | 第一版候选落地，需预览确认 |

说明：

- 辅轴第一版控制在 5 个，避免 LLM 过度纠结细碎表情。
- `ParamBrowLOutterUp` 在 `温和摇晃` 中出现异常大幅度，第一版不直接作为默认首选绑定，先留作人工验证对象。
- `BrowRInnerUp`、`BrowROutterUp` 命名与 `Param*` 体系不完全一致，第一版不作为首选绑定。

### 4.3 第一版运行时轴

| axis_id | 建议参数 | role | 说明 |
| --- | --- | --- | --- |
| `mouth_open` | `ParamMouthOpenY`，必要时验证 `ParamJawOpen` | `runtime` | 嘴巴开闭，主要交给说话口型/lip sync；非说话动作可谨慎使用 |
| `breath` | `ParamBreath` | `runtime` 或 `ambient` | 呼吸和持续起伏，默认由 runtime/ambient 管理 |

### 4.4 第一版不落地但保留观察

| 候选 | 原因 |
| --- | --- |
| `body_lift` / `body_depth` | 暂时被 `body_pitch` 合并承接，等 `BodyAngleY` 预览后再决定是否拆分 |
| `PhyBodyPositionY` / `PhyBodyUpperY` / `PhyBodyLowerY` | motion 证据强，但疑似物理/二级跟随，先不作为直控参数 |
| `PhyEyeLOpen` / `PhyEyeROpen` | motion 证据强，但第一版眼睛开闭优先绑定 `ParamEyeLOpen/ROpen` |
| `PhyMouthForm` / `PhyMouthX` | 可作为观察材料，第一版嘴部辅轴优先绑定 `ParamMouthForm/MouthX` |
| `Anim*` / `Exp*` | 不进入 LLM 主控轴 |

## 5. 第一版建议轴规模

### 5.1 主轴第一版

建议先落 12 个动作主轴：

```text
head_yaw
head_pitch
head_roll
body_yaw
body_roll
body_pitch
eye_open_left
eye_open_right
eye_smile_left
eye_smile_right
gaze_x
gaze_y
```

说明：

- `gaze_x/gaze_y` 第一版作为注意力方向主轴。
- `eye_smile_left/right` 第一版作为眼部动作主轴。
- `body_pitch` 第一版优先验证 `BodyAngleY`，暂不拆成多个身体上下/前后轴。

### 5.2 辅轴第一版

建议先落 5 个面部辅轴：

```text
mouth_smile
brow_bias
mouth_x
brow_left_detail
brow_right_detail
```

说明：

- 辅轴数量不要太多，否则 LLM 会过度纠结面部细节。
- 辅轴要有清楚语义说明，避免只给参数名。

## 6. 下一步建议

1. 根据本文把默认 `SemanticAxisProfile` 的 role 重新设计为动作主轴和表情辅轴。
2. 先确认 `BodyAngleY` 和 `PhyBodyPositionY` 的真实运行效果，决定身体上下/前后轴是否落地。
3. 更新 prompt，让 LLM 明确优先写动作主轴，再少量写表情辅轴。
4. 在 Action Lab/Profile Editor 中把轴按“主轴/辅轴/runtime/不建议暴露”分组展示。
5. 准备固定文本样例做人工预览：开心、害羞、惊讶后缩、疲惫、认真说明、生气、困惑。
