# TypeScript 运行时架构收口

## 当前结论

TypeScript 是 AG99live 的持续开发实现。当前版本已经把 Live2D 业务调用、播放身份和连接就绪状态收口到明确的组合根与端口边界；C++ 仍作为冻结大版本后的高性能稳定实现，继续遵循独立的原生架构拆分。

## 组合根与端口

`frontend/src/app/usePetDesktopRuntime.ts` 是桌面运行时组合根。基础依赖由
`frontend/src/app/desktopRuntimeFoundation.ts` 先组装：SessionStore、ModelSync、
Live2D RuntimePort、桌面设置端口和 ConversationPlayback。桌面根只继续装配
Presence、MotionLab、ModelEngine、桌面命令和 Vue 生命周期，不再让业务模块直接读取
`window.getLAppAdapter`。

Live2D 运行时能力由 `frontend/src/live2d/runtimePort.ts` 的 `Live2dRuntimePort` 表达。`createWindowLive2dRuntimePort()` 是唯一的 Window Adapter 适配层；动作预览、空闲动作、交互摇摆、鼠标凝视和语音口型通过注入端口调用。渲染器仍可直接使用 Cubism 初始化与画布生命周期，但运行效果设置同样经由该端口。

Electron preload 能力由 `frontend/src/desktop-bridge/desktopHostPort.ts` 的 `DesktopHostPort` 统一读取。截图、麦克风、PTT、Spout、窗口操作、Bilibili、设置窗口和桌面桥接模块不再直接读取 `window.ag99desktop`；全局对象只在端口工厂中出现。

语音口型的音频分析仍由前端音频运行时持有，`Live2dRuntimePort` 只接收外部音频信号。这样可以替换 Live2D 实现、测试播放编排，或在 C++ 运行时接入时保持上层调用形状稳定。

## 段身份与终态

`frontend/src/turn-playback/identity.ts` 定义共享的 `SegmentIdentity` 和 `MotionRunIdentity`。Timeline、MotionScheduler、MotionSink 和 SessionStore 使用同一套 trim、非空校验与复合键规则；`turnId`、`messageId`、`timelineId` 和 `runId` 不再由各模块自行拼接。

跨层调用通过 `frontend/src/turn-playback/sessionStorePort.ts` 使用显式的 Session/Segment 端口。Timeline、Orchestrator、Completion Coordinator、Adapter 入站运行时和桌面组合根不再依赖 `ReturnType<typeof useTurnPlaybackSessionStore>` 的完整实现形状；增量 text/audio/motion 流也通过同一端口推进。

`frontend/src/turn-playback/terminals.ts` 定义 Turn 与 Sink 的终态谓词以及 Sink 到 Turn 的转换。Timeline Engine 和 Runtime 通过共享谓词识别 `completed`、`failed`、`absent` 与 `interrupted`，避免不同模块把 `started` 或 `idle` 当作终态。

当前 SessionStore 的公开阶段仍使用 `completed/failed` 作为 Turn 终态；Timeline 的 `interrupted` 在 Session projection 中按失败原因投影，保留已有播放行为。若下一版本要把中断提升为独立业务阶段，应同时更新 SessionStore、Presence 和 Adapter 回执，不在单个播放器中局部扩展。

## Canonical settings 就绪握手

Adapter 在 WebSocket 初始化期间先回放 canonical desktop settings，完成后发送 `system.desktop_settings_sync_complete`。TS 连接状态将该事件记录为 `desktopSettingsSyncReady`，并提供 `waitUntilDesktopSettingsReady()`。

桌面组合根在连接后等待该就绪信号，再安装 Push-to-Talk 和启动 Bilibili Live。重连或断线会清除就绪状态；超时或未完成同步不会启动依赖本机配置的功能。Adapter 仍是桌面设置的唯一持久化 owner，localStorage 只保留客户端缓存。

## 尚未完成的边界

- `useAdapterConnection.ts` 仍是较大的连接组合模块，下一步可按 transport、inbound dispatch、desktop settings 和 lifecycle coordinator 拆分，但必须保持一个 WebSocket 与一个 PlaybackTimeline。
- `usePetDesktopRuntime.ts` 仍负责较多跨域观察器和桌面桥接回调，后续可提取 `DesktopRuntimeObservers`，不应重新引入全局 Live2D 访问。
- SessionStore、Timeline Runtime 和 ModelEngine 的状态写入仍有跨层回调；下一阶段应先用显式 `SegmentRuntimeState` port 收口，再考虑更大范围 reducer 化。
- Live2D 端口目前是 Window Adapter 的适配层，真实 Cubism/C++ 双实现等价仍需要模型、音频和设备上的运行验收。

## 验证

本次收口已通过前端 renderer、WebSDK 和 Node TypeScript 检查；Adapter Python 源码编译与协议/传输定向测试通过。真实 Electron、AstrBot、TTS、模型切换和重连场景仍需现场验收。
