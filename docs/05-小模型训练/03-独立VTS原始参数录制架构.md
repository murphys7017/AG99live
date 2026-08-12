# 独立 VTube Studio 原始参数录制架构

本文定义 `vts-data-recorder` 当前已经实现的边界。它是独立的本机原始参数录制器，不属于
AG99live 对话播放主链路，也不读写 Motion Lab 数据库。

## 1. 当前目标

录制器连接本机 VTube Studio，保存可追溯的 tracking input 与 Live2D 参数时间序列，并提供：

- `status`：检查 API 可达性，不触发授权。
- `discover`：完成授权并发现参数目录。
- `sample`：在内存中采样并输出质量摘要。
- `record`：把完整录制会话、take、参数帧和环境事件写入 SQLite。
- `list / inspect / delete`：查询质量、检查 take 和级联删除数据。

当前成功标准是原始录制事实能够稳定写入、查询、检查和删除，不是生成训练 JSON。

## 2. 独立边界

- 默认数据库位于 `%LOCALAPPDATA%\AG99live\vts-data-recorder\recordings.sqlite3`。
- `--database` 可以覆盖数据库位置，但数据库不应放进 Git 仓库。
- 录制器不读取、写入或迁移 `motion_lab.sqlite3`。
- 录制器不导入 AstrBot Adapter、Electron、ModelEngine 或 Motion Lab 模块。
- VTS token 只保存在本机配置文件，不写入数据库、日志或导出物。
- 录制器只读取 VTS 数据，不注入或修改模型参数。

VTS 数据与 Motion Lab 数据可以在未来的审核工具中共同作为证据，但不能通过共享数据库或隐式 ID
绑定制造第二个事实来源。

## 3. 录制事实

每个 `record` 创建一个 session 和一个 take。session 保存：

- 录制器版本、VTS endpoint 和请求采样率。
- VTS 版本与录制开始时的模型身份。
- 参数目录快照。
- 一份不可导出的目标占位快照。
- 会话状态和开始、结束时间。

take 保存：

- 操作者标签、开始和结束时间、持续时长。
- 完成状态、终止原因和环境稳定性。
- sampling quality report 或明确失败原因。
- 两层原始参数帧与 VTS/录制器事件。

## 4. 两层参数时间序列

### 4.1 Tracking input

回答“操作者与追踪器输入了什么”，适合观察面部、视线和姿态跟踪信号。

### 4.2 Live2D parameter

回答“当前模型参数最终呈现了什么”，适合观察模型参数范围、参数联动和物理响应。

每帧保存同来源序号、相对调度/发送/接收 monotonic 时间、VTS timestamp、模型 ID 和完整参数映射。
两层请求独立完成，不能把同一轮响应当作同一个渲染帧；后处理必须按本地时间轴对齐。

## 5. 环境事件与录制状态

录制器保存：

- `ModelLoadedEvent`
- `ModelConfigChangedEvent`
- `TrackingStatusChangedEvent`
- 事件订阅警告和录制器错误

模型加载或模型配置变化会使 take 标记为 `environment_changed`。参数请求失败、环境事件订阅不完整
等问题会形成 `completed_with_issues` 或失败状态。按下 `Ctrl+C` 会保存已经写入的帧，并将 take
标记为 `interrupted`。

这些状态必须保留真实原因，不能把不完整录制当作稳定样本。

## 6. 数据库结构

```text
recording_sessions
├─ 1:N parameter_catalog_snapshots
└─ 1:N recording_takes
   ├─ 1:N parameter_frames
   ├─ 1:N recording_events
   └─ 1:1 take_annotations（仅预留 schema）
```

### `recording_sessions`

保存会话元数据、模型身份、参数目录上下文、状态和 `target_contract_json`。

### `parameter_catalog_snapshots`

保存 tracking、custom 和 Live2D 参数名称、范围、默认值与原始定义。

### `recording_takes`

保存一次明确开始和结束的录制及其质量结论。

### `parameter_frames`

每行保存一层参数的一次完整响应。主键是 `(take_id, source, sequence_no)`，避免把每个参数拆成
大量独立行并丢失原始响应原子性。

### `recording_events`

保存 VTS 环境事件和录制器自身事件。

### `take_annotations`

数据库当前只预留审核状态、上下文、目标 JSON、推导版本、审核时间和说明字段。CLI 与存储 API
尚未提供审核读写路径，因此该表不能被描述成已经实现的标注系统。

## 7. 目标占位快照

当前 `default_target_contract()` 仍把旧实验假设写入 session：九级轴、时长范围和曲线枚举，同时明确
设置 `export_eligible=false`，原因是语义轴目录尚未完成标定。

这只是数据库中的不可导出占位元数据，不是已经批准的训练契约。二期 Performance Director、评价
标准和小模型职责稳定后，应直接修改该占位结构；不能因为历史录制包含它，就反向要求训练目标继续
沿用旧字段。

小模型边界见
[动作小模型训练前置条件与职责边界](./01-动作小模型训练前置条件与职责边界.md)。

## 8. 当前未实现

- 原始参数回放和审核 UI。
- 自动语义轴推导和人工标注工作流。
- 文本上下文编辑与真实对话关联。
- 训练 JSON/JSONL 导出。
- 与 AstrBot、Motion Lab、Electron 或 ModelEngine 的运行时接入。

这些功能必须在训练职责确定后再设计。纯 VTS 参数录制没有真实对话语义，不能直接成为文本到动作
的监督样本。

## 9. 验证原则

- 正式录制后应能查询 session、take、两层帧数、事件和稳定状态。
- 默认先使用 20 Hz；30 Hz 只有在 RTT、抖动和 VTS 性能复验后使用。
- 不把 tracking 与 Live2D 的同轮响应当作同一渲染帧。
- 数据库写入失败必须终止当前 take 并保留原因。
- `delete` 必须依赖 SQLite 外键级联删除 take 的帧、事件和预留标注。
- 自动检查只验证基础存储边界；真实采样质量需要在 VTube Studio 中观察。
