# AG99live VTube Studio Data Recorder

独立的 VTube Studio 原始参数录制器。它连接本机 VTube Studio，发现当前模型与参数，将可审计的原始时间序列写入独立 SQLite 数据库。

## 能力与边界

| 命令 | 作用 |
| --- | --- |
| `status` | 检查 API 状态，不认证。 |
| `discover` | 认证并列出当前模型、tracking input 与 Live2D 参数。 |
| `sample` | 只在内存中采样，输出质量报告。 |
| `record` | 保存一条独立录制 session 和 take。 |
| `live-record` | 连续保存一场直播的 VTS 参数、完整麦克风 WAV 和本地流式 STT 事件，直到指定时长或 `Ctrl+C`。 |
| `list-microphones` | 列出当前系统可用的麦克风名称和 ID。 |
| `annotate` | 为 take 添加原始指令、动作类型、审核状态和可选语义目标。 |
| `export` | 导出单条 take 的元数据、标注和完整参数帧 JSON。 |
| `list`、`inspect`、`delete` | 查询、检查或永久删除 take。 |

录制器不读取或写入 `motion_lab.sqlite3`，不向 VTube Studio 写参数，不生成动作语义，也不导出训练 JSON/JSONL。`live-record` 会保存本地 STT 的原始转录事件，供后续离线处理使用。

## 前置条件

1. 启动 VTube Studio，并在 Settings 中开启 Plugin API access。
2. 确认 API 地址；默认 `ws://localhost:8001`。
3. 使用 Python 3.11 或更高版本。

首次 `discover`、`sample` 或 `record` 会在 VTube Studio 中请求授权。token 默认保存在：

```text
%LOCALAPPDATA%\AG99live\vts-data-recorder.json
```

默认数据库为：

```text
%LOCALAPPDATA%\AG99live\vts-data-recorder\recordings.sqlite3
```

可分别用 `--token-file`、`--database` 覆盖路径；两者都不应放进仓库。

## 安装与使用

在本目录执行：

```powershell
python -m pip install -e .

python -m ag99_vts_recorder status
python -m ag99_vts_recorder discover
python -m ag99_vts_recorder sample --hz 20 --seconds 30
python -m ag99_vts_recorder record --hz 20 --seconds 30 --label calibration-head-roll
python -m pip install -e ".[live]"
python -m ag99_vts_recorder list-microphones
python -m ag99_vts_recorder live-record `
  --hz 20 `
  --stt-model C:\path\to\streaming-model `
  --microphone "麦克风名称" `
  --label stream-2026-11-07
python -m ag99_vts_recorder list
python -m ag99_vts_recorder inspect 12
python -m ag99_vts_recorder annotate 12 --status accepted --prompt "轻轻向左看" --action-kind motion_steps --note "动作自然"
python -m ag99_vts_recorder export 12 --output .\exports\take-12.json
python -m ag99_vts_recorder delete 12
```

地址不同的实例可使用：

```powershell
python -m ag99_vts_recorder --url ws://localhost:8002 sample --hz 20 --seconds 30
```

如需重新授权：

```powershell
python -m ag99_vts_recorder --reauthorize discover
```

## 录制事实

每个 `record` 保存：

- 当前模型、VTS 版本和参数目录快照。
- 独立的 tracking input 与 Live2D parameter 时间序列。
- 每帧的本地单调时间、调度时间、接收时间、VTS timestamp 和参数映射。
- 模型加载、模型配置、tracking 状态和录制器错误事件。
- 结束原因、环境稳定性和采样质量报告。

录制完成后，可以用 `annotate` 补充训练所需的人类上下文。标注命令默认保存为 `draft`，不会把 take 误标为已审核；确认动作可用时显式使用 `--status accepted`，明显不合格的 take 使用 `rejected`。`export` 只导出指定 take，不修改原始数据库，便于后续人工检查和训练数据转换。

`live-record` 默认使用系统默认输入设备。需要指定设备时，先运行 `list-microphones`，再把返回的精确 `name` 或 `id` 传给 `--microphone`。它不会按 VAD 把会话切成训练样本，而是保存一整段 WAV、VTS 参数帧以及流式 STT 的 `partial` / `final` 事件。`--stt-model` 指向包含 `tokens.txt` 和 `model*.onnx` 的本地 sherpa-onnx 模型目录；录制器不依赖 AstrBot 或现有项目数据库。

两类参数由独立请求获得，不能假定同一轮响应是同一个渲染帧。进度写入标准错误，最终 JSON 摘要写入标准输出，不包含 token 或完整逐帧转储。

`Ctrl+C` 会保存已批量写入的帧，并将 take 标记为 `interrupted`。模型或配置改变时 take 标记为 `environment_changed`；请求错误或事件订阅不完整时标记为 `completed_with_issues`。这些记录可用于排查，但不能作为稳定标定样本。

## 采样建议

默认先在 20 Hz 运行 30 秒，确认 RTT、抖动、模型稳定性和参数变化质量后，再测试最高 30 Hz。录制器拒绝超出 `0 < hz <= 30` 的参数。

训练边界和数据库设计分别见：

- [动作小模型训练前置条件与职责边界](../docs/05-小模型训练/01-动作小模型训练前置条件与职责边界.md)
- [独立 VTube Studio 原始参数录制架构](../docs/05-小模型训练/03-独立VTS原始参数录制架构.md)
