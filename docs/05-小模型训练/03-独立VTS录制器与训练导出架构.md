# 独立 VTube Studio 录制器与训练导出架构

> 文档状态：架构定案。本文定义 `vts-data-recorder` 的独立边界、数据库事实来源和训练导出
> 契约。它不替代动作系统设计，也不修改现有 Motion Lab 数据库。

## 1. 目标

`vts-data-recorder` 是一个独立的本机录制、审核和导出模块。它连接 VTube Studio，保存可回放的
原始参数时间序列，辅助人工得到语义动作标注，并只导出与动作决策小模型真实输出一致的数据。

```text
VTube Studio
-> 独立录制数据库
-> 回放与审核
-> 语义标注
-> 严格训练导出
```

它的成功标准不是“能写出一份 JSON”，而是任一已导出训练行都能回溯到完整的 VTS 原始数据和
审核结论，同时训练目标可被运行时动作决策入口直接接受。

## 2. 强制边界

### 2.1 独立存储

- 录制器拥有自己的 SQLite 数据库，默认位于本机应用数据目录，不在仓库内。
- 它绝不读取、写入或迁移现有 `motion_lab.sqlite3`。
- 它不导入 AstrBot Adapter、ModelEngine、Electron 或 Motion Lab 的 Python 模块。
- VTS token 继续只保存在本机配置文件，绝不写入录制数据库、导出文件或 Git。

现有项目只提供兼容性参考：当前动作决策小模型应输出什么，以及这些语义输出如何由运行时继续
展开。录制器不依赖项目运行中的数据库或进程。

### 2.2 不使用文件 take 格式

`PerformanceTake` 或逐条 JSON 文件不是主存储格式。录制会话、take、原始帧、事件和审核标注
都在录制器自己的 SQLite 数据库中。训练 JSON 只是一次可重复的导出结果。

### 2.3 原始参数不进入训练目标

VTS tracking input 与 Live2D parameter 的逐帧值仅用于：

- 校准语义轴和九级锚点；
- 识别动作起点、保持段和回收段；
- 回放、审核和重新推导标注；
- 排除模型切换、配置变化或 tracking 异常的 take。

它们不出现在文本到动作小模型的输出中。

## 3. 运行时兼容契约

第一版小模型的唯一输出是一个 `MotionDecisionTarget`：

```json
{
  "axis_levels": {
    "head_roll": 2,
    "body_roll": 1,
    "mouth_smile": 3
  },
  "duration_hint_ms": 1300,
  "curve": "quick_in_hold_soft_out"
}
```

约束如下：

- `axis_levels` 是稀疏对象；允许的轴来自录制开始时冻结的目标语义轴契约。
- 每个等级必须是 `-4..4` 整数；省略表示本轮不控制，`0` 表示明确中性。
- `duration_hint_ms` 是 `320..15000` 的整数提示值。
- `curve` 只能是 `default`、`quick_in_hold_soft_out`、
  `slow_in_hold_quick_out`、`pulse_then_settle`、`soft_breathe` 之一。
- 不存在 `intent_text` 字段，也不训练 `intent_tags`、完整
  `performance_curve_hint`、参数 ID 或逐帧曲线。

运行时接入层负责把这个小目标校验、补全并映射到当前正式动作协议。这个内部映射不应反向污染
训练目标。

### 3.1 冻结兼容契约

每个录制 session 创建时，录制器保存一份内部 `target_contract` 快照：允许的轴、等级范围、时长
范围、曲线枚举和目标模型标识。它用于审核和导出验证。

快照中的 ID、哈希、录制器版本和模型信息都属于数据库管理信息，不进入训练样本。当前项目的
语义轴或曲线规则改变时，必须显式创建新快照；旧 take 不能在新规则下无提示导出。

## 4. 三层数据

### 4.1 原始录制层

每个 take 保存两条独立时间序列：

- `tracking_input`：VTS 输入层，回答“操作者与追踪器输入了什么”。
- `live2d_parameter`：当前模型参数层，回答“模型最终呈现了什么”。

每帧保存相对 take 的调度、发送和接收 monotonic 时间，VTS timestamp、模型 ID 与
`parameter_name -> value` 映射。两层响应不是同一渲染帧，后处理必须按本地时间轴对齐。

### 4.2 审核标注层

审核记录保存：

- 当前状态：`draft`、`approved`、`rejected`；
- 审核后的 `axis_levels`、`duration_hint_ms`、`curve`；
- 推导算法版本、人工修改事实和审核说明；
- 可选的文本上下文。

录制阶段允许 `context` 为 `[]`。这种无文本 take 是轴、幅度、时长和曲线的标定数据，不能直接
导出为文本到动作监督样本。后续如果为一个 take 补充了真实用户文本、助手最终文本和必要历史，
它才具备导出资格。

### 4.3 训练导出层

导出器只读取审核通过且环境稳定的 take，并生成逻辑上等价于下列结构的样本：

```json
{
  "context": [
    {
      "role": "user",
      "content": "你今天心情怎么样？"
    },
    {
      "role": "assistant",
      "content": "当然很好啦，看到你就更开心了。"
    }
  ],
  "target": {
    "axis_levels": {
      "head_roll": 2,
      "mouth_smile": 3
    },
    "duration_hint_ms": 1300,
    "curve": "quick_in_hold_soft_out"
  }
}
```

训练框架可以把它转换为 JSONL messages、instruction/output 或其他封装；其中 assistant target 的
JSON 对象必须与 `MotionDecisionTarget` 完全一致。封装格式不得新增让小模型学习的管理字段。

以下字段永不导出：数据库主键、session/take ID、录制时间、操作者说明、VTS endpoint、VTS token、
模型 ID、契约快照、原始参数、帧时间、事件、审核说明、状态和推导版本。

## 5. 独立数据库

数据库以逻辑关系组织，具体命名在实现时固定为带 `vts_recording_` 前缀的表，避免与其他数据库
概念混淆。

```text
recording_sessions
├─ 1:N parameter_catalog_snapshots
└─ 1:N recording_takes
   ├─ 1:N parameter_frames
   ├─ 1:N recording_events
   └─ 1:1 take_annotations
```

### 5.1 `recording_sessions`

内部会话元数据：主键、开始/结束时间、录制器版本、VTS endpoint、目标采样率、VTS 版本、初始
模型身份、冻结的 `target_contract` 和会话状态。

### 5.2 `parameter_catalog_snapshots`

保存 session 开始时发现的默认 tracking parameter、custom parameter 和 Live2D parameter 清单，
包括名称、范围、默认值和来源。它解释帧中的参数名称，避免模型或 VTS 配置日后变化后失去语义。

### 5.3 `recording_takes`

一段明确开始和结束的表演录制。内部字段包括主键、所属 session、相对时间基准、开始/结束时间、
状态、操作者标签和环境稳定性。take 不保存训练管理字段到导出内容。

### 5.4 `parameter_frames`

一行是一层参数的一次采样，字段至少包含：take ID、来源、同来源序号、相对调度/发送/接收时间、
VTS timestamp、模型 ID 和数值 JSON。take 内同一来源的序号唯一，并以 `(take_id, source, sequence_no)`
建立索引。

每帧保存完整参数映射，而不是把每一个参数拆成一行。这样可以保持 VTS 原始响应的原子性，并在
20/30 Hz 下避免数据库行数不必要膨胀。

### 5.5 `recording_events`

保存 `ModelLoadedEvent`、`ModelConfigChangedEvent`、`TrackingStatusChangedEvent` 与录制器自身错误。
模型加载或模型配置事件使 take 环境不稳定；tracking 状态变化保留为事实，交由审核决定是否拒绝。

### 5.6 `take_annotations`

一条 take 一条当前审核标注。它保存审核状态、可选 `context`、审核后的 `MotionDecisionTarget`、
推导版本、审核时间和说明。`intent_text` 不建模，因为它不是输入也不是输出契约。

## 6. 写入、审核与导出流程

```text
建立 session 并冻结 target_contract
-> 发现并保存参数目录快照
-> 开始 take
-> 并发轮询两层 VTS 参数，批量写入 frame
-> 记录环境事件
-> 停止 take，标记稳定/不稳定
-> 从原始帧推导草稿标注
-> 人工回放与审核
-> 仅导出 approved + stable + 完整 context 的 take
```

帧写入使用 SQLite WAL、有限批量事务和 busy timeout；活跃 VTS 采样不等待 UI 或训练导出。任何写入
失败都使当前 take 明确失败，不以“没有录到数据”伪装成成功。

## 7. 首次实现范围

第一阶段正式录制模块只实现：

1. 独立数据库初始化与 schema 版本管理。
2. session、参数目录快照、take、frame 和 event 的事务写入。
3. `record` 命令，支持固定时长录制和 `Ctrl+C` 正常收尾。
4. `list` 与 `inspect` 命令，用于确认数据库内容和录制质量。
5. 数据库级删除 take，级联删除其 frame、event 和 annotation。

第一阶段不实现：

- 自动把原始参数推导为语义轴等级；
- 审核 UI、回放 UI 或文本上下文编辑 UI；
- 训练 JSONL 导出；
- 对现有 AstrBot、Motion Lab、Electron 或 ModelEngine 的改动。

这些功能在原始帧可稳定持久化、可查询、可删除后按顺序加入。

## 8. 验证原则

- 每次正式录制后，数据库应显示 session、take、两层 frame 数、事件和稳定状态。
- 20 Hz 是第一阶段默认速率；30 Hz 只在更长时段的 RTT、抖动和 VTS 性能复验后使用。
- 不把 tracking 与 Live2D 的同轮响应当作同一渲染帧。
- 导出前必须按冻结的 `target_contract` 验证轴、等级、时长和曲线。
- 导出后必须检查无数据库管理字段、无 VTS 参数、无时间序列、无 token。
- 训练/验证/测试按对话或脚本组切分，不能按单帧或同一表演的相邻 take 随机切分。

## 9. 已确定与待定事项

已确定：

- 录制器独立于现有动作系统与 Motion Lab。
- SQLite 是录制主存储，训练 JSON 是导出物。
- 纯 VTS 标定 take 可以没有文本，但不能直接进入文本监督训练集。
- 第一版训练 target 只有 `axis_levels`、`duration_hint_ms` 和 `curve`。

待定：

- 独立数据库的默认本机路径与备份策略。
- 当前固定模型允许训练的最终 `primary/hint` 轴清单。
- 从原始序列推导等级、时长和曲线的算法与人工审核界面。
- 训练框架选择后的具体 JSONL messages 封装。
