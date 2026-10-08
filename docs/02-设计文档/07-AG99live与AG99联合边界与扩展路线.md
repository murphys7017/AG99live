# AG99live 与 AG99 联合边界与扩展路线

> **状态：源码对照完成；产品定位与命名已确认，能力拆分顺序待定。**
>
> 本文是三份相关文档中的主文档：它记录两个仓库的真实职责、所有权边界和建议顺序。产品定位与名称归属见 [AG99 与 AG99live 产品定位与项目职责讨论稿](11-产品定位与项目职责讨论稿.md)；参考项目的抽象原则见 [参考项目与能力契约](08-参考项目与能力契约.md)，N.E.K.O 的产品功能见 [N.E.K.O 功能学习与 AG99live 边界扩展](06-N.E.K.O功能学习与AG99live边界扩展.md)。
>
> 本文中 “AG99” 指以桌面体验为中心的智能体主应用及其内部运行时；AstrBot 是上游来源。代码标识如 `astrbot` 包、`astrbot_plugin_` 前缀仍保留原样。

## 1. 结论先行

```text
AG99 = 以桌面端为重心的智能体主应用，内含宿主、模型和对话运行时
AG99live Adapter = AG99 与桌面身体之间的协议和业务能力层
AG99live Desktop = 播放、Live2D、音频和桌面 bridge 运行时
Native Runtime = 可独立选择的高性能协议/渲染实现
```

AG99live 是身体项目的仓库名与产品名；AG99 的产品重心转向桌面端，AG99live 承担身体能力。此方向不代表主应用入口整合已经完成，也不要求另设 “AG99 Desktop” 项目名称。

下一阶段不应先把 Live2D 核心拆成大量动态插件，而应把已有边界收敛成可检查的 capability。第一阶段保持静态组合；AG99 已有宿主级插件机制，AG99live 不再复制第二个 PluginManager。

## 2. 两个仓库的真实职责

### 2.1 AG99：宿主边界

AG99 的实际链路是：

```text
PluginManager 加载 MyPlugin
  → Star 构造函数和初始化注册 hooks / Web API / platform adapter
  → PlatformManager 创建并持有 OLVPetPlatformAdapter 实例
  → PlatformManager 管理平台实例的 run / terminate 任务
```

这里有三套需要区分的清理机制：

- **Context owner sweep**：清理 Web API、interaction contributor、persona effect、runtime sensor 和注册任务等 Context 能力；
- **模块路径注册清理**：按 owner/module 清理事件 handler 和 platform adapter 类注册；
- **插件或 Platform 自己的 disposer**：取消插件自行创建的任务，并释放 Adapter、WebSocket、媒体、设备等实例资源。

插件重载时，Star 的注册项会被重建，平台适配器类注册会被注销；但已经由 PlatformManager 持有的运行中平台实例有自己的生命周期，不应被当作插件注册表事实。AG99live 的 `reconcile_control_platforms()` 正是为这个差异重新绑定控制页 registry。

### 2.2 AG99live Adapter：协议和业务组合根

`OLVPetPlatformAdapter` 当前持有：

```text
RuntimeState / SessionState / TurnIdentityMap
StaticResourceServer / MediaService / MessageFactory
ChatBuffer / ConversationHistoryBridge / FrontendSystemCommandHandler
WebSocketTransport / DesktopSettingsBroker / TurnCoordinator
```

它应继续负责实例级组合和所有权结算，但具体能力可以逐步通过静态 registry/provider 注入。Adapter 不应下沉成 Live2D 播放器，也不应复制 AG99 的 LLM 生命周期。

### 2.3 Desktop 与 Native：两个可选实现

TypeScript 的 `usePetDesktopRuntime` 是 Vue 进程内的组合根，负责组装 Adapter 连接、PlaybackTimeline、ModelEngine、音频、桌面设置和 desktop bridge。窗口对象和窗口管理属于 Electron main process，不由这个 composable 直接持有。

`runtime-core` 是 Native 协议/运行时库，`render-core` 是完整的 Native 渲染宿主。TypeScript Desktop 与 `render-core` 可以分别直连 Adapter，用户手动选择运行哪一个；Adapter 当前只允许一个 WebSocket 客户端，因此两个运行时不能同时抢占同一连接。现阶段不需要先做 TS 到 C++ 的内部 IPC。

## 3. 所有权边界

| 状态或能力 | 唯一事实来源 | Adapter 可以做什么 | Desktop / Native 可以做什么 |
| --- | --- | --- | --- |
| AG99 事件、LLM、TTS、会话历史 | AG99 | 提交输入、读取结果、桥接历史 | 不直接访问 AG99 内部对象 |
| 协议版本和消息身份 | `protocol/schema_manifest.json` 与生成类型 | 校验、规范化、构造 envelope | 解析并执行，不私自改写身份 |
| Turn/Segment 终态 | Adapter TurnCoordinator + 桌面回执 | 结算输出、取消和失败 | 发送播放完成和中断回执 |
| 动作语义和参数计划 | TypeScript ModelEngine 规则；Native 以协议/样本对齐 | 传递受检验的动作语义 | 编译、调度和应用参数计划 |
| 播放时钟和 Timeline | 当前桌面运行时 | 不创建第二套播放时钟 | 管理音频、字幕、动作同步 |
| Live2D 模型和渲染资源 | Desktop / Native Host | 提供扫描、profile 和静态资源 | 加载、渲染、卸载和帧级状态 |
| Web 配置和插件 API | AG99 Context + AG99live Web API | 暴露受控查询和 action | 通过 bridge/broker 读写桌面拥有的设置 |
| 窗口、麦克风、Spout、ESP32 | Electron 或 Native Host | 发送命令和接收结果 | 持有设备句柄和资源生命周期 |

出现新功能时，先回答“它写入哪个事实来源、由谁停止、由谁发送终态”，再决定放在哪个仓库。没有 owner 的共享状态不能成为插件接口。

## 4. 四个参考项目在联合架构中的位置

- **Spatiotemporal Composability / Cordis**：指导副作用、依赖、Context、Provider 和 disposer；不替代 AG99 生命周期。
- **DeepSeek Harness**：指导把 Turn、Segment、诊断和 Companion 决策做成事实事件，再投影到 UI 和快照；不把高频渲染帧写进日志。
- **N.E.K.O**：指导主动对话体验、场景模式、角色/表演包和受控工具；主动对话与记忆沿用 AG99 现有能力，AG99live 优化状态、上下文和 Live2D 表现衔接。
- **AG99 自身**：已经提供宿主级插件发现、owner、加载/卸载、准入和 Web API；AG99live 只需补业务 capability 契约。

## 5. AG99live 的候选 capability

| Capability ID | 所在位置 | 主要职责 |
| --- | --- | --- |
| `ag99live.protocol` | Adapter `protocol/` | envelope、二进制帧、版本和错误 |
| `ag99live.turn` | Adapter runtime | Turn/Segment 身份、输出聚合和终态 |
| `ag99live.media` | Adapter services | 音频、图片、缓存和资源 URL |
| `ag99live.motion` | Adapter + Desktop | 动作语义、profile、参数计划 |
| `ag99live.desktop.playback` | Desktop / Native | Timeline、音频、字幕、动作终态 |
| `ag99live.desktop.model` | Desktop / Native | 模型发现、加载和卸载 |
| `ag99live.scene` | Adapter + Desktop（候选） | 目标是承载低频场景事实和桌宠交互信号；当前无对应协议消息或 Adapter→AG99 Observation 接线 |
| `ag99live.surface` | AG99 Web + Desktop bridge | snapshot、action 和最小权限 |

第一阶段这些 capability 都是静态导入。每个 capability 至少声明 ID、版本、依赖、启动/停止入口、输入输出、失败策略和诊断。

表中的 `ag99live.scene` 是目标设计占位，不是源码中已有的协议 capability。

## 6. 待设计的纵向切片：桌面主动性分层

主动表达策略已在 AG99；桌面事实到主动观察的入口尚未接入 AG99live。当前桌面主要接收 AG99 的主动输出：`send_by_session()` 建立桌面 Turn 并发送播放内容。现有链路有输出运输，没有桌面场景输入。

AG99 的 `Context.register_runtime_observation_sensor()` 可注册受限的事实来源，返回的 `RuntimeObservationSensorHandle.submit()` 可向现有 Personal Runtime Inbox 推送事实。但它只是提交句柄，不会采集桌面信息；AG99live 当前没有注册该 sensor。`personal_action` 和 `proactive_output` 是被校验器拒绝的保留 kind，不能作为插件 Observation 提交。

当前桌面→Adapter 已有文本/可选截图、麦克风流、打断与播放回执、设置和历史操作、Profile/动作调校及 Motion Lab 等消息；其中没有“用户回来”“触摸宠物”“桌面忙闲”等场景事实。因此以下是候选事件，不是当前实现：

```text
pet_interaction
user_returned
desktop_busy_or_available
```

需要将主动性拆成两个不同决策：

1. **语义决策**：是否有值得表达的内容、说什么、是否进入长对话，仍由 AG99 的 Observation Inbox、Gate、Policy 和 Persona/Output 决定。
2. **本地时机/输出准入**：桌面端根据当前交互、播放、安静模式和窗口状态，决定主动表达此刻可直接呈现、短暂延后还是抑制。该层只判断“现在适不适合开口”，不决定表达内容或创建第二套主动策略；目前这层尚未定义或实现。
3. **事实传递**：若 AG99 的 Policy 需要桌面事实，桌面端只发送经过授权、去抖/合并的低频事件，经新增协议消息进入 Adapter，再调用已注册的 Runtime Observation handle；不发送每帧、鼠标轨迹或连续设备状态。
4. **输出与收口**：获准的内容继续走现有 `send_by_session()`、`output.segment.v5`、PlaybackTimeline 和 Turn 终态；桌面本地准入需要能延后/抑制输出并保持终态正确，不应伪造播放成功。

时机层的实现位置仍待选择：可以从现有桌面 turn/playback 状态与本地状态机扩展，也可以独立成小型 Admission Policy；不应先假定需要新的 AG99 scheduler。

### Wake Scheduler 与 Heartbeat 是否能承接桌面场景

- `PersonalRuntimeWakeScheduler` 只负责按 deadline 唤醒已有的 retained Observation batch，以重评 defer、quiet-hours、cooldown 等延后事项；它不轮询桌面、不产生场景事实，也不负责本地即时输出准入。
- `PersonalHeartbeatSource` 默认关闭，默认间隔为 300 秒；它只针对配置的观察目标重评已有材料，空 Inbox 的 heartbeat 会被忽略。它不是桌面传感器。
- `personal_idle_initiation` 默认关闭，默认阈值 1800 秒，依据 AG99 记录的**会话用户活动时间**产生 `idle_initiation` Observation；它适用于聊天长期静默，不等于桌面用户离开/返回检测，也不能判断此刻是否适合语音输出。
- 因此这两个现成调度入口不能直接接管桌面场景。若需要长期桌面事实参与 AG99 决策，可由桌面端过滤后推送 Observation；本地即时开口准入仍需桌面端。

验收覆盖：不新增第二套语义主动策略；高频本地信号不触发 LLM；本地准入能在忙碌/播放/静音状态正确延迟或抑制；主动输出仍可打断并正确收口；Observation 只含必要、短小、经授权的事实。

## 7. 后续顺序

### Phase 0：确认三个边界

1. AG99 是宿主插件平台，AG99live 只做内部静态 capability registry；
2. TypeScript ModelEngine 是参考实现，Native 通过协议和黄金样本对齐；
3. 动态第三方插件不是当前产品前置条件。

### Phase 1：建立内部契约

新增最小的 `CapabilityId`、`RuntimeContext`、typed event、`Effect/Disposer`、生命周期和结构化错误，不改变现有消息行为。优先覆盖 WebSocket、任务、timer、IPC、设备和缓存等副作用。

### Phase 2：明确主动表达的本地准入边界

先从 AG99 和 AG99live 真实调用链确认语义决策、桌面事实输入、本地输出准入及终态 owner；再决定新增何种最小协议消息和 Adapter sensor 提交路径。复用 AG99 主动对话、记忆和 Provider，不另建主动策略。MotionLab 继续作为诊断 surface。

### Phase 3：逐步拆分组合根

按风险迁移：

1. 将 Adapter 的静态服务组装改为 registry 输入，但保留顶层 owner；
2. 将 TurnCoordinator 的事实事件和投影拆开，保持现有回执顺序；
3. 将桌面 transport、domain port、snapshot projection 分开；
4. 将 Web 路由、system message 和入站分发改成静态 registry；
5. 统一 manifest 到 Python、TypeScript、Native 的生成和检查。

### Phase 4：按真实场景决定是否动态化

只有外部扩展确实需要时，才评估插件目录、enable/disable、热重载、进程化 provider 或第三方 UI surface。

## 8. 暂不做的事

- 不复制 AG99 的 PluginManager、ConversationManager、Provider Manager 或认证系统；
- 不增加第二条桌面 WebSocket 或第二个播放时钟；
- 不让 Adapter 生成第二套动作编译规则；
- 不把 N.E.K.O 的完整记忆服务、多 Avatar 平台、插件市场和电脑控制 Agent 作为 Live2D 扩展前置条件；
- 不因为 C++ 性能较好就改变 TS 与 Native 的独立运行选择。

## 9. 当前验收边界

本次源码对照已经确认：

- AG99 负责插件、平台实例、Provider、Conversation、Web API 和插件重载；
- AG99live Adapter 负责协议、Turn/Segment、媒体、桌面设置 broker 和控制页业务；
- TypeScript Desktop 与 C++ Native 是两个独立的播放/渲染实现；
- 现有未提交的 Adapter 兼容改动和参考文档应保留。

仍需后续实现和真实运行验收：

- capability registry 的实际代码契约；
- 桌面场景事实到 AG99 Observation Inbox 的协议与 Adapter 接线；
- 本地即时开口准入与 AG99 主动策略的行为边界及终态收口；
- 插件重载与存活平台实例之间的完整清理/重绑定行为；
- TypeScript 与 Native 对同一组协议样本的行为一致性；
- Web 控制页、Electron 和 Native 的真实端到端行为。
