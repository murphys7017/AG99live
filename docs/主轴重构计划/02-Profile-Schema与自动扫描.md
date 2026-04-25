# 02 Profile Schema 与自动扫描

## 目标

每个 Live2D 模型生成并保存一份 `semantic_axis_profile.json`。

这份 profile 是后续所有模块的基础：

- prompt 生成
- ModelEngine 编译
- CouplingEngine 联动
- Runtime 参数写入
- Action Lab 动态调参 UI

## Profile 文件位置

建议保存位置：

```text
live2ds/<model_name>/ag99/semantic_axis_profile.json
```

或前端缓存位置：

```text
frontend profile cache / model profile store
```

最终应支持随模型导出/导入。

## Schema 草案

```json
{
  "schema_version": "ag99.semantic_axis_profile.v1",
  "profile_id": "Mk6_1.0.semantic.v1",
  "model_id": "Mk6_1.0",
  "source_hash": "live2d-folder-md5-or-sha256",
  "generated_at": "2026-04-26T00:00:00+08:00",
  "axes": [
    {
      "id": "head_yaw",
      "label": "头部左右朝向",
      "description": "控制 Live2D 头部左右朝向。50 为正面自然状态。",
      "semantic_group": "head",
      "control_role": "primary",
      "neutral": 50,
      "value_range": [0, 100],
      "soft_range": [42, 58],
      "strong_range": [30, 70],
      "positive_semantics": ["向右看", "右转头", "调皮侧看"],
      "negative_semantics": ["向左看", "左转头", "回避"],
      "usage_notes": "普通说话保持轻微偏移，极端侧头不要长期保持。",
      "parameter_bindings": [
        {
          "parameter_id": "ParamAngleX",
          "input_range": [0, 100],
          "output_range": [-30, 30],
          "default_weight": 1,
          "invert": false
        }
      ]
    }
  ],
  "couplings": [
    {
      "id": "head_to_body_yaw",
      "source_axis_id": "head_yaw",
      "target_axis_id": "body_yaw",
      "mode": "same_direction",
      "scale": 0.35,
      "deadzone": 6,
      "max_delta": 12
    }
  ]
}
```

## Axis 字段说明

| 字段 | 说明 |
|---|---|
| `id` | AG99live 内部语义轴 ID |
| `label` | UI 展示名 |
| `description` | prompt 和 UI 说明 |
| `semantic_group` | head/body/eye/mouth/brow/gaze/accessory 等 |
| `control_role` | primary/hint/derived/runtime/ambient/debug |
| `neutral` | 中心值，通常为 50 |
| `value_range` | 输入值范围，通常为 0..100 |
| `soft_range` | 日常轻微表现推荐范围 |
| `strong_range` | 明显表现推荐范围 |
| `positive_semantics` | 高于 neutral 的语义 |
| `negative_semantics` | 低于 neutral 的语义 |
| `parameter_bindings` | 具体 Live2D 参数映射 |

## 自动扫描输入

自动扫描应读取：

- `*.model3.json`
- `*.cdi3.json`
- `*.physics3.json`
- `Expressions/*.exp3.json`
- `Motions/*.motion3.json`
- 已有 `parameter_scan`
- 已有 `parameter_action_library`
- 已有 `base_action_library`

## 自动扫描步骤

### Step 1：参数候选识别

基于参数 ID 规则初步分类：

| 参数名特征 | 初步 group |
|---|---|
| `AngleX`, `ParamAngleX` | head yaw |
| `AngleY` | head pitch |
| `AngleZ` | head roll |
| `BodyAngleX` | body yaw |
| `BodyAngleZ`, `BodyAngleY` | body roll/pitch hint |
| `EyeBallX/Y` | gaze |
| `EyeLOpen`, `EyeROpen` | eye expression / blink runtime |
| `MouthOpen` | mouth runtime |
| `MouthForm`, `MouthSmile` | mouth smile |
| `Brow` | brow derived/hint |

### Step 2：motion/表情反推语义

从 motion 和 expression 中统计：

- 哪些参数经常随头部动作出现。
- 哪些参数只在表情文件出现。
- 哪些参数幅度大、影响明显。
- 哪些参数经常和 mouth/eye/brow 同时出现。

这一步用于补充参数名识别不足的问题。

### Step 3：生成初始 axes

扫描器输出初始 axes：

- 标准头部轴优先标为 `primary`。
- 眼部表情可标为 `primary` 或 `hint`。
- 身体轴默认标为 `derived`。
- 嘴巴张合默认标为 `runtime`。
- 眉毛默认标为 `derived` 或 `hint`。
- 未知高影响参数标为 `debug`，等待用户确认。

### Step 4：生成联动候选

根据识别结果生成基础 coupling：

```text
head_yaw -> body_yaw
head_roll -> body_roll
gaze_x -> head_yaw
gaze_y -> head_pitch
mouth_smile -> eye expression
eye expression -> brow
```

这些只是候选，前端应允许启用/禁用和调强度。

### Step 5：用户校正

前端 Profile Editor 需要支持：

- 修改 axis label/description。
- 修改 `control_role`。
- 选择绑定的 Live2D 参数。
- 设置 neutral/range/方向反转。
- 设置是否进入 prompt。
- 设置联动关系。
- 保存 profile。

## 缓存与变更检测

应复用 Live2D 文件夹 hash：

```text
source_hash unchanged -> 直接使用现有 semantic_axis_profile.json
source_hash changed -> 标记 profile 过期，提示重新扫描或手动确认
```

不能静默覆盖用户编辑过的 profile。

建议 profile 增加：

```json
{
  "user_modified": true,
  "source_hash": "...",
  "last_scanned_hash": "..."
}
```

## 第一版可接受的简化

第一版不要求自动扫描完全准确。

必须做到：

- 能生成可编辑 profile。
- 能识别标准头、眼、嘴、身体参数。
- 能把未知参数放入 debug 区域。
- 不把扫描失败伪装成成功。

不要求做到：

- 自动识别所有复杂服装/耳朵/尾巴参数。
- 自动判断所有参数正负方向。
- 自动生成完美 prompt。
