# AG99live Frontend

AG99live 的 Electron + Vue 桌面客户端。前端负责桌面窗口、协议接收、统一播放生命周期、动作编译、
Live2D 参数执行和创作工具，不负责对话模型、TTS 生成或后端 Turn 队列。

## 主要边界

```text
Adapter WebSocket v2
-> output.segment.v4 严格校验
-> TurnPlaybackSessionStore 原子提交协议事实
-> PlaybackTimeline 管理字幕、音频、动作和口型生命周期
-> ModelEngine 编译 engine.motion_intent.v4
-> engine.parameter_plan.v3
-> Live2D WebSDK 逐帧参数融合、Physics 和绘制
```

- `adapter-connection/`：握手、协议校验、入站分发和连接生命周期。
- `turn-playback/`：Turn 与 Segment 的稳定协议事实和释放策略。
- `playback-timeline/`：统一时钟、required sink 状态和执行终态。
- `model-engine/`：语义动作与模型参数计划的两阶段编译。
- `live2d/`、`live2d-renderer/`：模型加载、参数执行、口型、Cubism Physics 和渲染。
- `motion-lab/`、`action-lab/`：动作观察、历史、预览和调校工具。
- `desktop-bridge/`、`views/`：Electron 多窗口状态投影和用户界面。

SessionStore 不播放媒体，PlaybackTimeline 不解释动作语义，ModelEngine 不创建播放时钟，WebSDK
不读取 Turn 业务状态。非法协议、缺失时钟、编译失败或播放器拒绝都应形成明确失败，不使用默认动作
或旧协议掩盖问题。

## 开发命令

```powershell
cd frontend
npm install
npm run dev
```

常用静态命令：

```powershell
npm run typecheck
npm run build
npm run build:web
```

自动测试只用于最基础的输入输出边界，不代表 AstrBot、TTS、Electron、音频和 Live2D 的端到端行为
正确。真实播放效果仍需在完整运行环境中观察。

## 相关文档

- [项目总览与模块职责](../docs/01-架构与结构/01-项目总览与模块职责.md)
- [播放同步编排设计](../docs/01-架构与结构/04-播放同步编排设计.md)
- [ModelEngine 边界与分层设计](../docs/02-设计文档/01-ModelEngine边界与分层设计.md)
- [流程图与分析图集](../docs/04-流程图与分析图/README.md)
