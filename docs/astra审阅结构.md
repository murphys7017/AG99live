# 1. Executive Summary

**结论：核心架构成立，但局部已经出现架构漂移和增量开发债务。最需要处理的是播放装配边界、内部契约和历史入口，而不是重写动作引擎。**

如果今天重新实现相同产品目标，我仍会保留：

```text
AstrBot 对话生成
→ 原子输出段
→ 统一播放时间线
→ 语义动作编译
→ Live2D 参数执行
```

但不会重新设计出当前音频播放绕回 Adapter 的装配关系，也不会为固定编译阶段建立动态插件注册系统，更不会让同一内部依赖在入口声明必需、下游又处处判空。

最大的五个结构问题：

| 优先级 | 结构问题 | 判断 |
|---|---|---|
| P1 | 音频执行归在 Adapter 内，Timeline 又通过 Adapter 调回音频执行，形成运行时依赖环 | 已确认 |
| P1 | 内部契约没有贯彻到底：必需依赖被当作可选依赖，Store 查询返回可变内部对象 | 已确认 |
| P1 | 同一协议概念存在不同解释：动作 revision 校验不一致；`conversation_uid` 实际是客户端 UID | 已确认 |
| P2 | Remote Operator 的配置解析、Prompt 注入和路由策略分散，存在重复语义 | 配置解析已收敛；重复注入是否发生仍需验证 |
| P2 | 固定动作编译管线保留动态 registry、无调用者入口和历史状态写入 | 已确认 |

**AI 增量开发债务特征明显，但不是整个项目失控。** 存在“新增路径后旧入口未删”“声明必需后仍防御性判空”“固定流程保留未来扩展机制”等模式；不能仅凭这些模式断言具体代码由 AI 生成。

最值得先处理的区域：

1. `adapter-connection` 与 `playback-timeline` 的音频执行边界。
2. 内部入口、状态 API 和身份命名。
3. ModelEngine registry 与 Remote Operator 配置重复。

审计范围与证据边界：

- 以入口、核心调用链、状态所有者及发现驱动的引用追踪为主，没有机械逐文件扫描。
- 阅读了桌面宿主、后端适配、输出聚合、播放、动作编译、参数执行和数据记录的关键代码。
- VTS 录制器、B 站与 ESP32 仅检查独立边界和接入点，没有展开完整内部审计。
- 未修改任何文件。只读协议 manifest 一致性检查通过。
- 未启动 AstrBot、Electron、TTS 或 Live2D 实机链路；运行故障与外部兼容消费者没有被假定为已验证。

# 2. Actual Architecture

系统目标是：**把一次 AI 回复变成文本、语音、动作和口型同步的 Live2D 表演，同时保留可解释、可回放的数据。**

真实进程及模块关系：

```text
Electron 主进程
├─ 窗口 / 全局按键 / 原生麦克风 / 桌面能力
└─ Vue Renderer
   ├─ 辅助窗口：输入、历史、设置、动作实验室、Profile Editor
   │       │ commands ↑↓ snapshots
   │       └──────── DesktopBridge
   │
   └─ Pet 主窗口：usePetDesktopRuntime
       ├─ AdapterConnection ───────── WebSocket ───────────┐
       ├─ ModelSync                                      │
       ├─ TurnPlaybackSessionStore                       │
       ├─ 播放调度 + 完成确认                              │
       ├─ PlaybackTimeline                               │
       ├─ ModelEngine                                    │
       └─ Live2D Renderer / WebSDK                        │
                                                         │
AstrBot 进程                                             │
└─ MyPlugin + OLVPetPlatformAdapter ◀─────────────────────┘
   ├─ TurnCoordinator：输入、轮次关联、终态
   ├─ SpeechIngressService：音频输入、VAD、STT
   ├─ AstrBot event queue → 对话生成 / TTS
   ├─ Motion contributors：动作能力、上下文、结果转换
   ├─ OutputSegmentCoordinator：聚合原子输出段
   ├─ RuntimeState：配置、模型能力、Profile、样本访问
   ├─ MotionLab：观察记录与持久化
   └─ StaticResourceServer：模型、图片、音频
```

关键入口：

- 后端插件入口：[main.py](C:/Users/Administrator/Documents/GitHub/AG99live/astrbot_plugin_ag99live_adapter/main.py:37)。
- 平台注册与组件装配：[platform_adapter.py](C:/Users/Administrator/Documents/GitHub/AG99live/astrbot_plugin_ag99live_adapter/platform_adapter.py:57)。
- Electron 入口：[electron/main/index.ts](C:/Users/Administrator/Documents/GitHub/AG99live/frontend/electron/main/index.ts:1)。
- Renderer 入口：[src/main.ts](C:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/main.ts:1)。
- 主窗口装配：[usePetDesktopRuntime.ts](C:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/app/usePetDesktopRuntime.ts)。

最终结果产生在两个位置：

1. `HTMLAudioElement` 播放音频，文本 sink 更新展示。
2. `LAppModel.update()` 将参数计划与口型融合后交给 Cubism Physics 和绘制。实际顺序见 [lappmodel.ts](C:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/live2d/WebSDK/src/lappmodel.ts:713)。

核心状态并非全部归同一个对象，这是合理的：

- AstrBot：对话与生成。
- Adapter：轮次关联、尚未发送的输出材料。
- SessionStore：前端已接收材料和播放进度投影。
- Timeline：执行时钟与 sink 生命周期。
- ModelEngine：准备中的编译结果和当前动作 run。
- WebSDK：逐帧参数执行状态。

问题主要发生在这些所有权之间的**接口与投影契约**，不是缺少一级模块。

# 3. Critical Execution Paths

## 路径一：用户输入 → AstrBot → 原子输出

```text
输入窗口 / 麦克风 / B站批量输入
→ AdapterConnection outbound
→ WebSocketTransport
→ TurnCoordinator.handle_msg
→ MessageFactory / SpeechIngressService
→ _commit_inbound_message
→ AstrBot commit_event
→ AstrBot 生成与 TTS
→ OLVPetPlatformEvent.send_message_with_extras
→ Adapter.emit_message_chain
→ TurnCoordinator.emit_message_chain
→ OutputSegmentCoordinator
→ output.segment
```

真实调用证据：[输入与提交](C:/Users/Administrator/Documents/GitHub/AG99live/astrbot_plugin_ag99live_adapter/runtime/turn_coordinator.py:151)、[输出事件](C:/Users/Administrator/Documents/GitHub/AG99live/astrbot_plugin_ag99live_adapter/platform_event.py:28)、[输出段聚合](C:/Users/Administrator/Documents/GitHub/AG99live/astrbot_plugin_ag99live_adapter/runtime/output_segment_coordinator.py:97)。

各层价值：

- Transport：连接边界，必要。
- MessageFactory / SpeechIngress：框架对象转换与音频输入，必要。
- TurnCoordinator：轮次关联、提交和结束，必要。
- PlatformEvent：AstrBot 回调边界，必要。
- Adapter、TurnCoordinator 的出站 `emit_message_chain`：此路径主要转发，属于可合并的内部跳转。
- OutputSegmentCoordinator：文本、音频、动作与 speech cues 聚合，必要。

**不建议为了减少调用次数删除框架边界；可以消除框架边界之后的重复转交。**

## 路径二：输出段 → 音频、动作与完成确认

按主要组件节点计，音频启动经过：

```text
TurnPlaybackOrchestrator
→ PlaybackTimelineRuntime
→ segmentJobExecutor
→ AdapterConnection.releaseAudioForTimelinePlayback
→ AdapterAudioRuntime
→ AdapterAudioTimelineController
→ audioPlaybackStateBridge
→ AudioSegmentRunner
→ AudioSegmentSink
→ BrowserAudioSink
→ HTMLAudioElement
```

这是 **11 个节点**，不含节点内部再次调用 Timeline 的回调：

- 7 个软件节点有实际语义：调度、生命周期、字幕策略、UI 投影、终态映射、口型绑定、浏览器音频。
- 3 个节点主要承担转发或装配。
- 1 个平台执行节点。

最明显的结构问题是：

```text
Timeline 执行音频
→ Adapter 的播放接口
→ Adapter 内部音频 runtime
→ 回调 Timeline 更新终态
```

这不是第二个音频播放器，但确实是**执行所有权绕过协议模块的运行时依赖环**。

证据：[Timeline 装配](C:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/app/playbackTimelineWiring.ts:40)、[Adapter 音频 runtime](C:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/adapter-connection/runtime/audioRuntime.ts)、[音频控制器](C:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/adapter-connection/runtime/audioTimelineController.ts)。

动作分支则为：

```text
Timeline motion sink
→ ModelEngine 接收已规范化意图
→ 等待音频时钟 / 准备编译结果
→ semantic stages
→ model_parameter stages
→ 参数计划或受控 motion resource
→ WebSDK 执行
```

这里“等待真实音频时钟”有必要，不能简单把 pending motion 判成重复队列。

完成链：

```text
audio / motion / lip-sync terminal
→ Timeline
→ SessionStore 投影
→ PlaybackCompletionCoordinator
→ control.playback_finished
→ 后端 _finish_turn
→ control.turn_finished
```

本地播放完成与后端轮次完成是不同事实，ACK 协议应保留。

## 路径三：Profile 修改 → 编译能力更新

```text
Profile Editor
→ DesktopBridge authoring command
→ Pet 主窗口
→ Adapter system command
→ RuntimeState.save_semantic_axis_profile_update
→ 校验 revision / 保存 Profile
→ model_sync
→ ModelSync
→ 后续 ModelEngine 编译
```

证据：[Profile 保存入口](C:/Users/Administrator/Documents/GitHub/AG99live/astrbot_plugin_ag99live_adapter/runtime/state.py)、[ModelSync](C:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/adapter-connection/model-sync/useModelSync.ts:37)。

这些层跨越窗口、进程和持久化边界，基本都有必要。辅助窗口没有直接持有第二套 Adapter，是合理设计。

# 4. Architecture Drift

| 声明或设计意图 | 实际代码 | 偏差 |
|---|---|---|
| Adapter 是连接与协议边界 | Adapter 内创建音频执行 runtime，并参与字幕释放 | 播放职责没有完全退出协议模块 |
| SessionStore 外部写入必须经过方法 | `getSession/getSessions/getSessionById` 返回内部可变对象 | 所有权依赖调用方自律 |
| 正式动作使用一个 V4 契约 | 前端与后端对 `profile_revision` 的合法输入判断不同 | 版本相同不代表行为契约相同 |
| `SessionState.stage` 是连接 UI 投影 | 仓库引用中只有写入，没有实际读取 | 投影消费者已经消失，维护代码仍在 |
| ModelEngine 扩展通过 registry 挂载 | 正式调用只使用固定阶段和 `resolve` | 文档中的扩展能力没有第二个真实消费者 |
| 原生麦克风启动失败后可浏览器 fallback | 显式选中原生设备时启动失败直接抛错 | 文档比当前代码宽泛 |

Store 查询证据：[useTurnPlaybackSessionStore.ts](C:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/turn-playback/useTurnPlaybackSessionStore.ts:115)。

协议差异：

- Python 要求正整数：[motion_intent.py](C:/Users/Administrator/Documents/GitHub/AG99live/astrbot_plugin_ag99live_adapter/motion/motion_intent.py:85)。
- TypeScript 接受正的有限数，再 `Math.round`：[normalize.ts](C:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/model-engine/normalize.ts:128)。

麦克风差异见[架构总览](C:/Users/Administrator/Documents/GitHub/AG99live/docs/01-架构与结构/01-项目总览与模块职责.md)与[实际启动分支](C:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/adapter-connection/runtime/microphoneCapture.ts:77)。应修正文档，而不是为了匹配旧文字重新添加 fallback。

# 5. Redundancy Map

| Location | Concept / Responsibility | Duplicate With | Severity | Recommendation |
|---|---|---|---|---|
| Adapter 音频 runtime、controller | 播放启动和停止转交 | Timeline 音频执行链 | P1 | 合并装配，音频执行归 Playback |
| Motion V4 前后端解析器 | 相同 wire contract | revision 等字段规则各自实现 | P1 | 保留两端边界校验，统一规则与契约样例 |
| Remote Operator middleware 配置解析 | 可用电脑、默认电脑、profile | RemoteOperatorRuntime 配置解析 | P2 | 已改为 Runtime 权威解析的 Prompt 投影 |
| 两个 Remote Operator Prompt collector | 同一 Prompt 构造 | 同一个 `collect_remote_operator_prompt_extension` | P2 / VERIFY | 查清 Core 阶段后收敛注册入口 |
| 音频 StateBridge、Runner | 启动异常分类 | 两套错误名称映射 | P2 | Runner 产生统一错误，UI 只翻译 |
| SessionStore `finalizeSession` | 转入 completed | `markPhase(..., "completed")` | P2 | 删除无调用者入口 |
| ModelEngine `ingestInboundPayload` | unknown → normalized → queue | 正式入站已 normalize，再调用 `ingestNormalizedPayload` | P2 | 删除未使用入口 |
| 动作 metadata 多种字段名 | motion payload 提取 | `motion_payload / intent / plan` | P2 / VERIFY | 核实消费者后只保留 canonical 字段 |

Remote Operator 原本不是仅仅“有两个 DTO”：middleware 曾自行解释 `computer_entries`、backend、enabled 和默认 profile，而 runtime 还额外检查 `allow_unrestricted_access`。这会让 Prompt 暴露一个运行时必然拒绝的目标。

现在 middleware 只把 Runtime 的可执行目标策略投影为 Prompt 配置，包含 `allow_unrestricted_access`。仍待验证的是两个 Core Prompt collector 是否会在同一阶段重复注入。

证据：[middleware Prompt 投影](C:/Users/Administrator/Documents/GitHub/AG99live/astrbot_plugin_ag99live_adapter/middleware/remote_operator.py:342)、[Runtime 权威解析](C:/Users/Administrator/Documents/GitHub/AG99live/astrbot_plugin_ag99live_adapter/services/remote_operator_runtime.py:67)。

# 6. Concept Drift

| Canonical Concept | Current Names | Conflict | Recommended Naming |
|---|---|---|---|
| 客户端身份 | `client_uid` | 固定客户端身份，不表示某一轮对话 | 保留 `client_uid` |
| 当前轮次对话 | `conversation_uid`、`turn_id` | 当前实现中二者应指向同一轮次 | `conversation_uid` 使用当前 `turn_id` |
| 前端播放轮次 | `turn_id/playbackTurnId/sessionId/currentGroup` | 部分是框架身份区别，部分只是旧命名 | 对外统一 `turnId`；框架 ID 显式加前缀 |
| 前端事件轮次 | `event_frontend_turn_id/scheduled_frontend_turn_id` | 后者 property 直接返回前者 | 合并为 `frontend_turn_id` |
| 最新轮次展示 | `SessionState` | 容易误解成所有轮次的权威状态 | 删除无消费者字段后再判断是否需要独立对象 |
| 一个动作意图 | `motion_payload/intent/plan` | plan 与 intent 的层级含义不同 | `motion_intent` 或统一 payload 字段 |
| 最近送出的动作 | `prompt_motion_history` | 是后端输出记录，不是已成功播放的物理姿态 | `recent_emitted_motion_intents` |
| 执行完成 | `stopped/interrupted/completed` | 部分 stopped 被映射成成功接管 | 显式区分完成、接管、中断 |

最实质性的身份偏差：

[MotionObservationRecorder](C:/Users/Administrator/Documents/GitHub/AG99live/astrbot_plugin_ag99live_adapter/runtime/motion_observation_recorder.py:136) 把固定的 `session_state.client_uid` 错写为 `conversation_uid`；当前轮次应使用对应的 `turn_id`。动作调度和 Prompt 观察也曾采用相同错误来源。

`conversation_uid` 应用于当前轮次关联；AstrBot 历史会话仍由 `history_uid` / `conversation_id` 表示。当前 MotionLab 观察入口尚未填充历史会话字段。

# 7. Complexity Hotspots

## A. 播放生命周期与装配

**位置：** AudioRuntime、Timeline、SessionStore、ModelEngine、主窗口 lifecycle 回调。

**必要复杂度：**

- 真实音频时钟。
- 字幕延迟到音频开始。
- motion、audio、lip-sync 分别终止。
- 中断和相邻动作接管。
- ACK 等待本地执行收口。

**偶然复杂度：**

- 播放进入 Adapter 再返回 Timeline。
- 多个公开接口转交相同动作。
- 必需依赖的延迟绑定与可选类型交错。
- 主窗口同时捕获 ModelEngine、Timeline、Recorder 的观察回调异常。

最后一点值得关注：关键状态推进和非关键记录都经过 `notifyMotionLifecycleObserver` 的 catch-and-log。它可以防止一个观察者影响其他观察者，但**关键 Timeline 推进失败后，没有同等明确的恢复契约**。这是故障传播风险，尚未证明实际出现过挂起。

**建议：** 播放执行归一个装配区域；明确关键状态回调失败必须如何结束 segment，非关键记录失败才允许隔离。

## B. 动作编译与 Performance Schedule

**必要复杂度：** 九级语义轴、模型绑定、关系图、动作序列、语音 phrase、部位延迟及逐帧约束，均对应真实产品需求。

**偶然复杂度：** 动态 stage registry、未使用的 raw ingress、跨文件重复的 segment identity 处理。

**建议：** 保留编译阶段，删除运行期插件机制。不要把复杂编译算法重新包装成更多 Director、Manager、Provider。

## C. RuntimeState

**当前职责：** 配置读取、provider 选择、模型扫描、缓存、Profile 保存、样本存储、参考例解析和 model-sync 投影。

这是实际后端中心，消费者通过它获取过多能力。

**必要复杂度：** 后端需要统一当前模型能力。

**偶然复杂度：** 配置、存储和能力事实通过一个大对象横向可达，调用方使用 `Any/getattr` 探测其内部成员。

**建议：** 先让调用方只接收确实需要的现有对象或函数。没有必要立刻拆出多个新 Service。

## D. Remote Operator

拥有两种真实执行后端，因此 backend 分支不是假扩展。

但路由权分布在：

```text
关键词识别
→ 可用电脑筛选
→ system prompt override
→ 删除冲突工具
→ LLM JSON 选择
→ 结果解析
→ runtime 执行
```

这些步骤分别有意义，但同一 request 的选择依据没有形成统一输入快照。

**建议：** 同一份解析后的配置与可用性视图驱动 Prompt、工具仲裁和执行校验。

## E. 可选 Performance Curve

**真实问题：** 给动作提供额外表现提示。

**成本：** 第二次模型调用、请求关联、异步结果存储、取消、错过输出窗口处理、前后端 hint 契约。

当前主模型已有动作意图，前端也有确定性的表演编排，所以该子系统需要证明增量收益。

**判定：QUESTIONABLE / NEEDS VERIFICATION。** 需要检查实际启用率、及时命中率和观感改善，不能仅凭它“可选”就认定值得长期维护，也不能断言已被前端完全替代。

# 8. Legacy / Compatibility Debt

| 项目 | 已知消费者或原因 | 删除影响 | Verdict |
|---|---|---|---|
| 官方 AstrBot `<@anim>` 模式 | README 明确支持；代码存在完整入口 | 官方环境失去动作输出 | **KEEP** |
| Persona Effect / TTS 可选 hook | 官方与增强版 Core 差异 | 无法在官方环境加载或正确工作 | **KEEP**，探测集中在边界 |
| message ID 优先级树 | 消费不同 AstrBot 输出 metadata | 可能改变分段聚合 | **VERIFY** 配套 Core 实际输出 |
| motion object 三种 type、三种 payload 字段 | 本仓库 producer 只输出 canonical 组合 | 潜在外部 producer 受影响 | **VERIFY → DELETE** 无消费者别名 |
| `scheduled_frontend_turn_id` 同值别名 | 内部诊断和调度读取 | 已统一调用方，无独立语义损失 | **DONE** |
| SessionStage 与 last_user_text | 未找到读取者 | 删除写入不改变现有消费者行为 | **DELETE** |
| 动态 compiler extension API | 未找到运行期修改消费者 | 固定编译不受影响 | **DELETE / SIMPLIFY** |
| 扫描缓存 schema 失配重建 | 模型与缓存变化 | 删除后会使用陈旧缓存 | **KEEP** |
| 桌面快照失效后恢复默认值 | 持久化数据边界 | 无效本地数据可能阻碍启动 | **KEEP** |
| Web / native 麦克风 | 两种实际采集环境 | 删除会减少输入支持 | **KEEP** |
| 无动作资源加载的重复分支 | 前面的零动作总数分支已 return | 无可达行为损失 | **DELETE** |

本仓库的 canonical motion producer 见 [scheduling.py](C:/Users/Administrator/Documents/GitHub/AG99live/astrbot_plugin_ag99live_adapter/middleware/interaction_motion/scheduling.py:105)，宽泛 consumer 见 [message_utils.py](C:/Users/Administrator/Documents/GitHub/AG99live/astrbot_plugin_ag99live_adapter/runtime/message_utils.py:44) 和 [output_segment_coordinator.py](C:/Users/Administrator/Documents/GitHub/AG99live/astrbot_plugin_ag99live_adapter/runtime/output_segment_coordinator.py:254)。

**没有发现足以证明“旧版动作引擎仍完整并行运行”的证据。** schema 名称同时有 v1/v2/v3/v4，主要是不同协议对象各自版本，不等于四代实现同时存活。

# 9. Abstraction Audit

| Abstraction | Purpose | Actual Value | Verdict |
|---|---|---|---|
| OutputSegmentCoordinator | 汇集回复段材料 | 强业务语义，避免音频与动作归属不明 | GOOD |
| PlaybackTimelineEngine | 统一时钟与 sink 生命周期 | 核心产品价值 | GOOD |
| AudioSink | 隔离浏览器媒体行为 | 即使只有一个正式实现，也有平台边界价值 | GOOD |
| ModelSync | 当前模型能力投影 | 清晰、实例化、只读暴露 | GOOD |
| semantic / model_parameter 阶段 | 将语义转换成执行计划 | 两阶段各有独立语义 | GOOD |
| 动态 StageRegistry | 注册、排序、禁用、卸载扩展 | 现有固定管线没有使用动态能力 | UNNECESSARY |
| AdapterAudioRuntime + TimelineController | 音频装配及 API 转交 | 分散播放 ownership | QUESTIONABLE |
| PlaybackCompletionCoordinator | 本地完成与后端 ACK | 职责真实；可与 turn policy 同文件收敛 | GOOD |
| SessionProjection | Timeline → Store 状态映射 | 投影必要；必需 port 可选化不必要 | GOOD，收紧契约 |
| `_FrontendIdentitySnapshot` | 包装一个轮次 ID 并提供同值别名 | 没有新增语义 | UNNECESSARY |
| Remote Operator 两种 client | 对接不同执行协议 | 存在两个真实后端 | GOOD |
| DesktopBridge | 多窗口命令与状态投影 | 真实进程/窗口边界 | GOOD |
| 单行出站转发包装 | 穿过 Adapter、Coordinator | 部分是框架接口，部分仅增加跳转 | QUESTIONABLE |

registry 的实际实现包含 `register/unregister/setEnabled/list`、extension 集合和运行期约束，但生产代码只看到固定构造及 `resolve`。证据：[registry.ts](C:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/model-engine/compiler/registry.ts:45)。

**应删除的是动态机制，不是十个有业务语义的编译阶段。**

# 10. State Ownership Audit

| State | Current Owner | Other Writers | Source of Truth | Problem / Recommendation |
|---|---|---|---|---|
| 连接状态 | Transport / AdapterConnection | lifecycle 回调 | 当前连接实例 | 边界基本成立 |
| 后端轮次 | TurnCoordinator | 通过回调结束、清理 | 轮次 maps 与 Core 事件关联 | SessionState 不是完整轮次 owner；删除无消费投影 |
| 对话状态 | AstrBot conversation manager | HistoryBridge 调框架 API | AstrBot | 保留，不另建会话数据库 |
| Agent 状态 | AstrBot；RemoteOperatorRuntime 管委托任务 | 外部执行结果 | 各自 runtime | 外部 Core 内部 ownership 未审计 |
| 前端 turn 材料 | SessionStore | Inbound dispatcher 通过 API | SessionStore | 查询返回可变对象，收紧读取接口 |
| 播放执行状态 | Timeline | audio/motion/lip-sync 终态回调 | Timeline | Store 应明确只是执行投影 |
| 动作准备状态 | ModelEngine | scheduler、prepare、start、cancel | pending / prepared maps | 有实际缓存价值，统一失效和身份契约 |
| 逐帧参数状态 | WebSDK active runtime | direct plan、speech source | ActiveParameterRuntime + Cubism model | 合理，应保留 |
| Observation | MotionLab recorder / SQLite | 多处记录入口 | 已持久化 raw events | 统一客户端与 conversation 身份 |
| 当前 Prompt context | Motion contributor 构建 | 最近动作、fewshot、事件内容 | 本次构建结果 | 不是长期 memory；最终 token budget 在外部 Core，需验证 |
| 最近聊天摘要 | ChatBuffer | 输入提交、输出发送、历史切换 | 有界本地投影 | 不应宣称为 AstrBot 完整 conversation history |
| 长期 Memory | AstrBot；本仓库另存动作样本/观察 | 框架及样本保存入口 | 各自持久化存储 | 不应把 MotionLab 当作通用 Agent memory |
| runtime 配置 | plugin config 文件/注入快照 → RuntimeState | refresh | 当前配置来源 | 多处重复解析；按一次快照消费 |
| 模型配置 | 后端 Profile 与模型资源 | Profile 保存命令 | 后端持久化 Profile | 前端 ModelSync 和窗口快照是投影 |
| 桌面设置 | Pet 主窗口 runtime 与持久化设置 | 辅助窗口通过命令 | 按设置域的主窗口状态 | 不把辅助窗口快照升级为 owner |

这里没有证据支持“整个播放系统存在多个彼此平权的权威状态库”。

更准确的问题是：

> Timeline 已被设计为执行 owner，但它的状态需要经过多个回调和 Store 投影才能被调度与完成协调读取；部分接口又允许绕开这些约束。

同样，Store 返回可变对象证明的是**封装可被绕过**，本次没有证实生产调用者已经通过该漏洞直接修改状态。

# 11. Deletion Candidates

以下候选优先于新增抽象。

| 文件 / 类 / 函数 / 配置 | 为什么可删除 | 谁仍依赖 | 风险 | 置信度 |
|---|---|---|---|---|
| `payload_dispatch.validate_motion_payload` | 仓库源码引用只有定义 | 未找到调用者 | 低 | 高 |
| `useModelEngine.ingestInboundPayload` | 正式链调用 normalized 入口；旧入口只定义和导出 | 未找到调用者 | 低 | 高 |
| SessionStore `finalizeSession` | 当前完成协调使用 `markPhase` | 未找到调用者 | 低 | 高 |
| `SessionStage`、`stage`、`last_user_text` | 状态只写不读 | 自身及对应写入调用 | 低至中 | 高 |
| `_mark_turn_synthesizing/_mark_turn_playing` 及注入回调 | 仅维护上述无消费者 stage | OutputSegmentCoordinator | 低至中 | 高 |
| registry 动态修改 API 及其 disabled-extension 状态 | 无注册、启停、卸载调用 | 固定编译依赖 resolve，需保留静态阶段顺序 | 中 | 高 |
| `lappmodel.ts` 第二个 `motionGroupCount == 0` 分支 | 总动作数为零时前面已 return | 无可达路径 | 低 | 高 |
| `_FrontendIdentitySnapshot` 同值 property | 已删除，调用方直接使用 `event_frontend_turn_id` | — | 低 | 已完成 |
| motion object 历史 type / payload 别名 | 本仓库没有对应 producer | 外部 Core/插件未知 | 中 | NEEDS VERIFICATION |

删除依据位置：

- [未使用 payload 校验包装](C:/Users/Administrator/Documents/GitHub/AG99live/astrbot_plugin_ag99live_adapter/motion/payload_dispatch.py:18)
- [旧 ModelEngine 入站入口](C:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/model-engine/useModelEngine.ts:181)
- [重复完成 API](C:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/turn-playback/useTurnPlaybackSessionStore.ts:721)
- [仅写状态](C:/Users/Administrator/Documents/GitHub/AG99live/astrbot_plugin_ag99live_adapter/runtime/session_state.py:9)
- [不可达加载分支](C:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/live2d/WebSDK/src/lappmodel.ts:538)
- [同值身份包装](C:/Users/Administrator/Documents/GitHub/AG99live/astrbot_plugin_ag99live_adapter/middleware/interaction_motion/shared.py:18)

“未找到调用者”限定于本仓库源码引用追踪，不代表证明互联网上不存在外部导入者。但这些内部函数没有已知外部兼容承诺，不能因此默认永久保留。

# 12. Merge Candidates

| 候选 | 合并理由 | 保留的边界 |
|---|---|---|
| AdapterAudioRuntime、AudioTimelineController 与音频装配 | 实际都在装配/转交同一播放执行链 | BrowserAudioSink 与 Timeline 生命周期 |
| Remote Operator 两套配置解析 | 同一份配置不应有两套合法性与默认值规则 | Prompt 投影和 executor 类型可以不同 |
| TurnPlaybackOrchestrator 与 CompletionCoordinator 的策略组织 | 同一个播放 turn 的释放和完成条件 | 不把网络发送、音频实现塞进策略 |
| `_FrontendIdentitySnapshot` 与其使用点 | 一个字段不需要对象加别名 | 前后端 turn ID 的真实区别保留 |
| 动作错误原因拼接逻辑 | middleware/shared 与 payload_validation 存在相同默认实现及注入 | 领域校验函数保留 |
| PlatformEvent 之后的输出转发 | Adapter、TurnCoordinator 在该路径没有增加语义 | AstrBot 平台方法与 OutputSegment owner 保留 |

最后两项优先级较低。不能因为存在一行包装，就牺牲稳定框架边界；也没有必要为错误字符串再建立一个 Service。

# 13. Simplification Opportunities

## 1. 音频播放：11 个组件节点 → 约 6 个职责节点

```text
Turn playback policy
→ Timeline / segment execution
→ Audio runner
→ Browser audio + lip-sync binding
→ HTMLAudioElement
```

UI 状态从执行事件投影，网络 Adapter 不再成为播放必经路径。

## 2. 动态编译机制 → 固定阶段序列

```text
Map + order + kind + enabled predicate
+ disabledExtensions + register/unregister/setEnabled
→ 两个显式、有序阶段数组
```

仍然可以保留 `runCompilePipeline`；不需要删除有意义的算法阶段。

## 3. 内部 fallback tree → 明确必需契约

已确认的典型问题：

- `CreateAdapterConnectionOptions.sessionStore` 必需，但入站依赖声明为 `undefined` 可选，并使用 `?.`。
- `RuntimeState` 构造时创建 `performance_curve_runtime`，Coordinator 仍逐层 `getattr` 查方法。
- `TurnCoordinator` 必然收到 SessionState，却使用 `getattr(..., "mark_playing")`。

**A 类保护应保留：** 网络输入、LLM 输出、磁盘数据、浏览器能力、外部 AstrBot 能力差异。

**B 类保护应收紧：** 本仓库装配完成之后，对已知对象和必需方法的“有就调用，没有就忽略”。

入口过滤外部事件后，缺少内部 Adapter/Coordinator 应明确诊断，不应与“这不是本插件事件”返回同一种空结果。

## 4. 两种协议解释 → 一个行为契约

manifest 当前只统一版本字符串，没有定义字段的接受、拒绝和规范化规则。

先统一：

- revision 必须整数。
- 超出 tag 数量是拒绝还是截断。
- ID 的允许形状。
- 必需/可选字段。
- absent、failed、interrupted 的意义。

不必立刻新增 schema 编译框架；一组权威规则与跨端边界样例即可先收敛。

## 5. 多个可变状态出口 → 一个受控写入口

Store 查询应返回只读对象；内部可变访问只留在 Store 实现内。保留响应性，不需要每次深复制整个 session。

## 6. 隐式成功接管 → 显式生命周期语义

目前 [MotionTimelineRunTracker](C:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/playback-integrations/modelEngineMotionSink.ts:232) 将特定 `stopped + direct_parameter_plan_replaced` 解释为 completed。

相邻动作接管是真实需求，**不应简单删掉这一处理**。应使接管成为明确的执行结果，减少根据字符串恢复语义。

# 14. Recommended Target Architecture

不新增顶层“万能 Runtime”，也不推倒重写。自然收敛为：

```text
INPUT
  文本 / 麦克风 / 弹幕
          │
          ▼
ASTRBOT ADAPTER
  协议边界 + Turn 关联
          │
          ▼
ASTRBOT
  对话 / 工具 / TTS
  Motion contributor 提供模型能力与动作意图
          │
          ▼
OUTPUT SEGMENT
  原子材料聚合
          │
          ▼
PLAYBACK
  Turn 材料 + 释放/完成策略 + Timeline
          │
          ├─ Audio / subtitle / lip-sync
          │
          └─ ModelEngine
               固定语义编译 → 参数计划
                         │
                         ▼
LIVE2D
  参数融合 → 响应 → Physics → Draw
```

旁路：

```text
Profile / 模型资源 → 能力事实 → ModelSync / ModelEngine

执行与编译事件 → MotionLab
主窗口状态 → DesktopBridge → 辅助窗口

VTS Recorder → 独立原始参数数据库
Remote Operator → 两种外部执行后端
```

与当前结构相比：

- **真实业务复杂度保留：** 分段、音频时钟、语义编译、参数融合、多窗口。
- **历史结构收敛：** 音频离开 Adapter，固定管线不再伪装成动态插件系统。
- **增量债务删除：** 无调用者入口、同值别名、无消费者状态、内部可选依赖。

# 15. Simplification Plan

优先顺序：**DELETE → MERGE → SIMPLIFY → REFACTOR → ADD**。

| Priority | Action | Scope | Benefit | Risk | Prerequisite |
|---|---|---|---|---|---|
| P0 | 暂无已证实必须紧急修改项 | — | 避免把架构风险夸大成生产事故 | — | 若真实播放存在无法收口，再升级 |
| P1 | SIMPLIFY：收紧内部契约和 Store 读取接口 | SessionStore、Inbound deps、关键 lifecycle 回调 | 缺失状态不再静默跳过，写入权可执行 | 中 | Inbound 必需依赖和 Store 只读查询已完成；关键 lifecycle 回调的故障语义仍待验证 |
| P1 | MERGE：播放装配从 Adapter 收归 Playback | 音频 runtime、controller、wiring | 消除执行依赖环和转发层 | 中高 | 保留开始、失败、中断、接管与 ACK 语义 |
| P1 | SIMPLIFY：统一身份与协议含义 | revision、conversation/client ID | 防止同版本不同解释及数据分组歧义 | 中 | 已完成源码入口修正；历史数据和 history_uid 关联仍需核对 |
| P2 | DELETE：删除高置信度无用入口与分支 | 第 11 节前三项、加载重复分支 | 直接减少维护面 | 低 | 引用核对后做最小静态检查 |
| P2 | DELETE：删除无消费者阶段状态 | SessionStage 与回调传播 | 去除虚假状态机 | 低至中 | 保留仍消费的 turn identity 与计数 |
| P2 | SIMPLIFY：动态 registry 改固定阶段 | ModelEngine compiler | 阶段顺序直接可见 | 中 | 保持现有阶段顺序和诊断 |
| P2 | MERGE：Remote Operator 配置解析 | middleware/runtime | 默认值、可用性与执行目标一致 | 中 | 已使用 Runtime 权威解析；保留两种真实 backend |
| P2 | VERIFY → DELETE：清理 motion metadata 别名 | message_utils / segment extraction | 缩小内部协议 | 中 | 配套 AstrBot 源码与真实 payload |
| P3 | VERIFY：合并双 Prompt 注册路径 | Remote Operator | 防止重复注入及多次决策 | 中 | 确认 Core 两种 collector 的调用阶段 |
| P3 | VERIFY：评估可选 curve 子系统去留 | curve runtime/coordinator/hint | 可能移除整块非必要复杂度 | 中 | 命中率与观感证据 |
| P3 | 修正文档漂移 | ownership、麦克风、扩展机制 | 文档重新可用于导航 | 低 | 与最终实现同步 |

执行上可以先完成低风险 DELETE，再处理 P1 跨边界变化；表中 P1 表示结构重要性，不要求先做高风险迁移。

# 16. Things You Would NOT Change

1. **原子 output segment。**
   文本、音频、动作和 speech cues 有共同身份，是整个系统最有价值的边界之一。

2. **真实音频时钟与无音频 synthetic clock 的区分。**
   无音频动作需要时钟，这不是掩盖音频失败的 fallback。

3. **语义意图与参数计划分离。**
   LLM 不直接输出 Live2D 参数名，模型差异由 Profile 和编译器吸收，方向正确。

4. **ActiveParameterRuntime 与 Cubism Physics 的分工。**
   主动参数先融合，Physics 后处理，有清楚的执行顺序。

5. **显式失败，不自动替换非法动作。**
   当前已经存在 schema 拒绝、Profile revision 校验和明确终态，应继续强化。

6. **主窗口唯一 runtime、辅助窗口命令与快照模式。**
   多窗口投影并非重复维护一套业务系统。

7. **ModelEngine 内的真实编译阶段。**
   文件多不等于抽象多；轴解析、关系图、时间编排、参数绑定确实解决不同问题。

8. **MotionLab 的持久化确认和待发送队列。**
   本地待确认事件与后端已持久化事件有不同职责，不是应无条件合并的双份 memory。

9. **独立 VTS 录制器。**
   原始跟踪数据采集与语义动作观察不是同一种数据，不应为了“统一”强行共用数据库或 runtime。

10. **官方 AstrBot 兼容支持与两个 Remote Operator backend。**
    都有真实产品场景。应削减内部扩散，而不是默认删除能力。

# 17. Final Verdict

**1. 如果维护两年，第一件想删除什么？**

ModelEngine 动态 stage registry 的运行期扩展机制。保留阶段函数与固定顺序，删除没有消费者的注册、卸载、启停能力。

具体落地可以先从无调用者入口和不可达加载分支开始，风险更低。

**2. 第一件想合并什么？**

Adapter 内的音频 runtime/controller 与 Playback 音频装配，让播放不再绕回连接模块。

**3. 最大架构风险是什么？**

播放完成依赖跨 Timeline、Store、ModelEngine、主窗口回调和后端 ACK 的一致推进，而内部契约并未完全强制执行。未来局部改动容易造成“某层认为完成，另一层仍在等待”。

目前这是源码支持的结构风险，不能据此断言线上已经发生。

**4. 哪个核心设计值得保留？**

`原子输出段 + 统一时间线 + 语义动作编译`。

**5. 哪个设计最明显过度工程？**

固定编译流程上的动态插件 registry。其次是音频执行路径中的多层装配转发。

**6. 项目目前更像什么？**

**Manageable Technical Debt，伴随局部 Architecture Drift 和 Accumulated AI-generated Debt 特征。**

部分区域需要结构收敛，但不足以判定整个系统需要重写，也不宜整体贴上 Over-engineered 标签。

**7. 如果只能做三件事？**

1. 删除无消费者状态、旧入口和动态 registry，保留固定编译阶段。
2. 把音频执行收归 Playback，收紧 Store 与 lifecycle 契约。
3. 统一协议、身份和 Remote Operator 配置解释，清理没有已知消费者的内部别名。

**现在的代码不是实现目标最简单的一种方案，但它已经具备可以自然收敛的正确骨架。应优先做减法，让现有核心设计真正成为唯一执行路径。**
