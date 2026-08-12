# AG99live VTS Data Recorder

这是独立的 VTube Studio 参数录制器。它连接本机 VTS，发现参数，并将可回放的原始参数时间序列写入自身的 SQLite 数据库。

当前能力：

- `sample`：仅内存采样，用于检查连接、参数与采样质量；进程结束后原始帧丢弃。
- `record`：创建独立录制会话与 take，批量保存 tracking input、Live2D 参数帧和 VTS 环境事件。
- `list`、`inspect`、`delete`：确认录制质量、查看 take 摘要和级联删除不需要的 take。

它当前**不会**：

- 读取、写入或迁移 `motion_lab.sqlite3`；
- 创建 `PerformanceTake` 或以逐条 JSON 文件作为主存储；
- 生成文本、`intent_text`、`intent_tags`、`axis_levels`、时长或曲线标签；
- 导出训练 JSON/JSONL；
- 向 VTS 注入或修改任何参数。

## 前置条件

1. 启动 VTube Studio。
2. 在 VTS Settings 中开启 `Allow Plugin API access`。
3. 确认 API 地址。默认是 `ws://localhost:8001`，但 VTS 中可以修改端口。
4. 使用 Python 3.11 或更高版本。

首次执行 `discover` 或 `sample` 时，VTS 会显示插件授权窗口；在 VTS 中确认后，token 只保存在本机用户配置目录：

```text
%LOCALAPPDATA%\AG99live\vts-data-recorder.json
```

可用 `--token-file` 覆盖这个位置，但不要把该文件放进 Git 仓库或动作数据库。

录制数据库默认位于：

```text
%LOCALAPPDATA%\AG99live\vts-data-recorder\recordings.sqlite3
```

可用全局参数 `--database <path>` 覆盖该位置。数据库只保存录制器内部事实，VTS token 不会写入其中。

## 安装与运行

在本目录执行：

```powershell
python -m pip install -e .
```

检查 API 状态，不请求授权：

```powershell
python -m ag99_vts_recorder status
```

完成授权并列出当前 tracking input 与 Live2D 参数：

```powershell
python -m ag99_vts_recorder discover
```

以 20 Hz 采样 30 秒：

```powershell
python -m ag99_vts_recorder sample --hz 20 --seconds 30
```

只有 20 Hz 的结果稳定后，再测试 30 Hz：

```powershell
python -m ag99_vts_recorder sample --hz 30 --seconds 30
```

以 20 Hz 将 30 秒原始帧写入独立数据库：

```powershell
python -m ag99_vts_recorder record --hz 20 --seconds 30 --label calibration-head-roll
```

`record` 期间按下 `Ctrl+C` 会正常收尾并保存已批量写入的帧；take 会标记为 `interrupted`。模型加载或模型配置变更也会持久化当前帧和事件，但 take 会标记为 `environment_changed`，不能作为稳定录制使用。任何参数请求失败或环境事件订阅不完整都会标记为 `completed_with_issues`，同样不能作为稳定标定数据。

查看数据库中的 take：

```powershell
python -m ag99_vts_recorder list
python -m ag99_vts_recorder inspect 12
```

永久删除一个 take 及其帧、事件和未来的审核标注：

```powershell
python -m ag99_vts_recorder delete 12
```

端口或地址不同的示例：

```powershell
python -m ag99_vts_recorder --url ws://localhost:8002 sample --hz 20 --seconds 30
```

如需让 VTS 重新弹出授权窗口：

```powershell
python -m ag99_vts_recorder --reauthorize discover
```

## 录制内容

每个 `record` 会创建一个 session 和一个 take。session 保存录制器版本、VTS endpoint、模型身份、参数目录快照和内部目标契约快照；take 保存：

- 两条独立时间序列：`tracking_input` 与 `live2d_parameter`；
- 每帧的相对调度、发送、接收 monotonic 时间、VTS timestamp、模型 ID 与完整参数映射；
- `ModelLoadedEvent`、`ModelConfigChangedEvent`、`TrackingStatusChangedEvent` 与录制器错误；
- 结束原因、环境稳定性和采样质量报告。

帧批量事务写入，SQLite 使用 WAL、外键级联和 busy timeout。`inspect` 只输出帧计数、事件和质量报告，不把完整原始帧打印到终端。

`sample` 输出 JSON 摘要，不含 token。它按 `tracking_input` 和 `live2d_parameter` 两个来源分别报告：

- 请求与有效采样频率；
- 请求 RTT 的平均值、P50、P95、最大值；
- 相邻响应间隔与相对目标周期的平均抖动；
- 调度错过次数、请求错误和超时；
- 每个观察到的参数最小值、最大值和变化次数；
- 采样期间收到的模型、模型配置与 tracking 状态事件。

采样和录制的开始与进度提示写到终端的标准错误流，最终 JSON 摘要写到标准输出。正常的 30 秒操作会在结束前保持运行，不会逐帧输出参数值。
按下 `Ctrl+C` 会结束采样并输出已收集样本的部分报告，其中 `termination_reason` 为 `interrupted`。
若 VTS 在采样期间加载模型或修改模型配置，探针会停止采样并把 `sampling.environment.capture_stable` 标记为 `false`；tracking 状态变化会作为事件事实保留在报告中。

RTT 以本地 monotonic clock 计算。两层参数通过独立请求获取，不能假定同一轮的两条响应代表同一个渲染帧。

## 后续边界

本阶段只建立原始录制事实。数据库中的 `target_contract` 仍是
`export_eligible=false` 的旧实验占位，不代表已经确定训练目标。审核、回放、语义标注和训练导出
会在 Performance Director、评价标准和小模型职责稳定后重新设计；数据库主键、VTS 参数、原始帧、
事件和管理字段都不得作为训练输入。

当前架构边界见
[独立 VTube Studio 原始参数录制架构](../docs/05-小模型训练/03-独立VTS原始参数录制架构.md)。
