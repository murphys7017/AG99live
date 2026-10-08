# AG99live Frontend

Electron + Vue 桌面客户端负责模型展示、用户交互、播放编排和 Live2D 执行。它连接本机 Adapter，接收完整的 `output.segment` 消息（Payload Schema 为 `output.segment.v5`），并把每段回复呈现为同步的音频、字幕、动作、口型和 Physics。

## 边界

```text
AdapterConnection
  -> TurnPlaybackSessionStore
  -> TurnPlaybackOrchestrator
  -> PlaybackTimelineRuntime
  -> ModelEngine
  -> AG99 Live2D runtime
  -> transparent canvas / Spout2
```

- `adapter-connection/` 负责连接、协议解析和入站分发。
- `turn-playback/` 保存段事实、顺序和播放投影。
- `playback-timeline/` 负责时钟、sink 生命周期与终态。
- `model-engine/` 把语义动作编译为参数计划或预检资源。
- `live2d/`、`live2d-renderer/` 负责模型加载、参数融合、口型、Physics 和绘制。
- `spout/` 与 `electron/main/spout-sender.ts` 发布透明 Live2D 画布给 `AG99live.Live2D` Sender。
- `motion-lab/`、`action-lab/`、`views/` 和 `desktop-bridge/` 提供调校、窗口和桌面能力。

SessionStore 不播放媒体，Timeline 不解释动作语义，ModelEngine 不创建第二个时钟，Live2D runtime 不读取 Turn 业务状态。

## 开发

```powershell
cd frontend
npm install
npm run dev
```

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | 检查 renderer、WebSDK 和 Electron main-process 类型。 |
| `npm run build` | 类型检查后构建桌面端。 |
| `npm run build:web` | 检查并构建 Web renderer。 |
| `npm run build:spout-sender` | 使用 MSVC x64 重建 Windows Spout2 Sender。 |
| `npm run package:win` | 重建 Spout、构建 Electron 并生成 Windows x64 安装包。 |
| `npm run package:win:dir` | 重建并生成未压缩的 Windows x64 可运行目录，用于安装包前验收。 |

Spout Sender 需要 Visual Studio Build Tools，并将输出放入 `resources/spout/`。渲染进程只在 Live2D 画布完成真实绘制后读取帧，保留预乘 Alpha；OBS 应使用预乘 Alpha 合成模式。

Windows 安装包构建：

```powershell
cd frontend
npm ci
npm run package:win
```

安装包输出到 `frontend/release/`。该流程会将 Electron runtime、生产依赖、`uiohook-napi` 原生模块、Live2D Core 公共资源以及 Spout Sender 和 DLL 一起纳入安装包。构建 Spout Sender 需要安装带 MSVC x64 工具链的 Visual Studio Build Tools。

也可以直接双击仓库根目录的 `build-installer.cmd`，自动完成依赖安装、Spout 编译和 Windows 安装包构建。`runtime-core/` 是独立的原生运行时，不会被纳入本安装包。

## 验证范围

类型检查和编译测试覆盖协议与实现边界。真实播放需要在 AG99、TTS、Electron、真实 Live2D 模型和 OBS 中确认音频起播、口型、参数收势、快速中断、窗口切换和透明输出。

深入设计见[文档中心](../docs/README.md)。
