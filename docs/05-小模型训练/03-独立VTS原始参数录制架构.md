# 独立 VTube Studio 原始参数录制架构

## 目标

录制器建立可审计的原始事实：当前 VTube Studio 模型、两层参数时间序列、环境事件和采样质量。它是独立工具，不是 AG99live 前端运行时的一部分。

## 独立边界

- 数据库不读取、写入或迁移 `motion_lab.sqlite3`。
- 录制不生成文本、`intent_tags`、`axis_levels`、时长、曲线标签或训练样本。
- 录制器不向 VTube Studio 注入或修改参数。
- 数据库的历史目标占位不构成已批准训练契约。

## 记录结构

| 表 | 内容 |
| --- | --- |
| `recording_sessions` | 录制器版本、端点、模型身份、参数目录快照和内部目标占位。 |
| `parameter_catalog_snapshots` | 当次模型可见参数目录。 |
| `recording_takes` | 一次录制的开始、结束、状态和质量摘要。 |
| `parameter_frames` | tracking input 与 Live2D parameter 的原始帧和时间信息。 |
| `recording_events` | 模型、配置、tracking 状态和录制器错误。 |
| `take_annotations` | 预留的审核资料；当前 CLI 不提供标注读写。 |

SQLite 使用独立数据库、WAL 和外键级联。默认文件为：

```text
%LOCALAPPDATA%\AG99live\vts-data-recorder\recordings.sqlite3
```

## 状态与质量

`record` 在中断时保存已写入批次并标记 `interrupted`。模型或配置变化会标记 `environment_changed`；请求错误或事件订阅不完整会标记 `completed_with_issues`。这些 take 可以保留作诊断，但不能当作稳定的标定资料。

`sample` 和 `record` 分别报告请求频率、有效频率、RTT、抖动、错过调度、错误、超时、参数范围和变化次数。最终 JSON 写入标准输出，进度写入标准错误。

## 当前未实现

- 原始参数回放与审核 UI。
- 自动语义轴推导、人工标注和文本关联。
- 训练 JSON/JSONL 导出。
- 与 AG99、Motion Lab、Electron 或 ModelEngine 的运行时接入。

训练职责稳定后，才能在不污染原始数据边界的前提下设计这些功能。

相关命令见 [录制器 README](../../vts-data-recorder/README.md)，训练边界见[动作小模型训练前置条件与职责边界](01-动作小模型训练前置条件与职责边界.md)。
