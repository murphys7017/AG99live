# VTube Studio API 能力与本项目读取边界

## 本项目的用途

`vts-data-recorder` 是独立的 VTube Studio 参数录制器。它通过 VTube Studio Public API 发现当前模型和两类参数，记录采样时钟与环境事件，并写入独立 SQLite 数据库。

它不控制 VTube Studio，不写入任何 Live2D 参数，不读取或迁移 Motion Lab 数据库，也不导出训练 JSON/JSONL。

## 连接与认证

默认地址为 `ws://localhost:8001`。使用前应在 VTube Studio 中开启 Plugin API access。首次认证需要在 VTube Studio 确认；token 默认保存到：

```text
%LOCALAPPDATA%\AG99live\vts-data-recorder.json
```

token 可以通过 `--token-file` 改写位置，但不应进入仓库或录制数据库。

## 已读取的 API 事实

| 数据 | 用途 | 注意事项 |
| --- | --- | --- |
| API 状态与 VTS 版本 | 记录会话环境 | `status` 不触发认证。 |
| 当前模型身份 | 确认录制环境 | 模型变更会使当前稳定录制失效。 |
| Tracking input 参数 | 观察输入层 | 与模型参数不是同一渲染帧。 |
| Live2D model 参数 | 观察模型层 | 受 VTS mapping、smoothing、motion、expression 与 Physics 影响。 |
| 模型、配置和 tracking 状态事件 | 标记环境变化 | 事件缺失会反映在录制质量中。 |

两层参数通过独立请求获取。必须记录各自本地单调时间、RTT 和实际接收时间；不能把同一轮请求当作同一绘制帧。

## 采样边界

录制器只允许 `0 < hz <= 30`，默认 20 Hz。先在目标机器验证 20 Hz 的 RTT、抖动和 VTS 性能，再评估是否需要 30 Hz。它不会假设 60 Hz 或更高频率适合当前用途。

真实 VTube Studio 环境仍需要确认：参数目录、模型切换、tracking 丢失、配置变化、事件订阅质量以及不同参数层之间的时延。

## 官方资料

上游 API 的消息名称和版本由 VTube Studio Public API 文档决定。本项目文档只描述录制器实际调用的能力；升级 VTube Studio 或 API 时，应先以官方文档和真实连接结果复核，再修改此页和录制器实现。
