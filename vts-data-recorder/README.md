# AG99live VTS Data Recorder

这是给第一轮 VTube Studio 参数采集验证使用的独立探针。它只连接本机 VTS、发现参数并在内存中短时采样，输出连接与采样质量报告。

它当前**不会**：

- 写入 `motion_lab.sqlite3`；
- 创建 `PerformanceTake`、训练 JSON 或其他录制文件；
- 生成文本、`intent_text`、`intent_tags`、`axis_levels`、时长或曲线标签；
- 向 VTS 注入或修改任何参数。

这一步的目的是先观察当前固定模型在真实 VTS 环境中的 tracking input 与最终 Live2D 参数，并验证 20 Hz、30 Hz 轮询是否足够稳定。原始帧数据在本版本结束进程后即丢弃。

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

端口或地址不同的示例：

```powershell
python -m ag99_vts_recorder --url ws://localhost:8002 sample --hz 20 --seconds 30
```

如需让 VTS 重新弹出授权窗口：

```powershell
python -m ag99_vts_recorder --reauthorize discover
```

## 报告内容

`sample` 输出 JSON 摘要，不含 token。它按 `tracking_input` 和 `live2d_parameter` 两个来源分别报告：

- 请求与有效采样频率；
- 请求 RTT 的平均值、P50、P95、最大值；
- 相邻响应间隔与相对目标周期的平均抖动；
- 调度错过次数、请求错误和超时；
- 每个观察到的参数最小值、最大值和变化次数；
- 采样期间收到的模型、模型配置与 tracking 状态事件。

采样中的开始与进度提示写到终端的标准错误流，最终 JSON 报告写到标准输出。正常的 30 秒采样会在结束前保持运行，不会逐帧输出参数值。
若 VTS 在采样期间加载模型或修改模型配置，探针会停止采样并把 `sampling.environment.capture_stable` 标记为 `false`；tracking 状态变化会作为事件事实保留在报告中。

RTT 以本地 monotonic clock 计算。两层参数通过独立请求获取，不能假定同一轮的两条响应代表同一个渲染帧。

## 后续边界

探针通过后，才单独设计并实现写入现有动作实验室数据库的录制会话、动作记录与帧表。届时数据库保留原始参数时间序列，训练导出仅保留审核后的文本上下文、`axis_levels`、`duration_hint_ms` 和 `curve`。
