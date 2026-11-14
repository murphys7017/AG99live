# Adapter、Interaction Orchestrator 与 Provider 重构计划

> **状态：设计/计划**
>
> **复核日期：2026-11-14**
>
> **当前进度：Phase 0/1 的中立契约、黄金事件序列、AstrBot callback bridge、TTS/Motion 生命周期事件适配和首条文本/Avatar Output 垂直切片已建立；Interaction Orchestrator 已承接 Provider 事件订阅、STT/TTS/Motion 主动请求入口、前端协议解析与 Turn 行为分发、活动事件 owner、连接清理、AstrBot event stop 调度、SegmentAssembler 与增量输出入口、Turn/Segment 事实快照、Conversation 事实回流、取消注册、terminal registry、终态提交/回滚、`control.turn_started`/`control.turn_finished` 和 timing 状态；`output.segment.v6` 与 `control.synth_finished` 已统一通过 AvatarOutputPort 发布。AstrBot TTS/Motion/STT capability binding、生命周期事实转换、Provider Registry 和 Provider 组合根已收敛到 `adapters/astrbot`。**
>

## 1. 目标

将 AG99live 从“依附 AstrBot 的大型 Adapter”逐步收敛为：

```text
AG99live Desktop / Native Avatar Runtime
        ↕
Interaction Orchestrator
        ↕
Platform Adapter
        ↕
Capability Providers
```


最终职责分层如下：

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| Avatar Runtime | Live2D、ModelEngine、PlaybackTimeline、音频播放、字幕、口型、动作执行、桌面设备 | 解释平台会话、调用上游模型、创建第二套 Turn |
| Interaction Orchestrator | Turn/Segment 生命周期、身份绑定、输入接收、输出聚合、打断、播放准入和终态 | 平台认证、平台会话细节、具体模型或 TTS 实现 |
| Platform Adapter | 连接平台、提交输入、接收平台事件、处理平台会话、转换平台格式 | 自己实现 TTS、STT、动作编译、播放时钟或输出段规则 |
| Capability Provider | Conversation、STT、TTS、Motion 等单项能力 | 持有平台专属生命周期或直接控制前端播放 |

## 2. 当前源码基线

当前真实输入和输出路径是：

```text
WebSocketTransport
  → TurnCoordinator.handle_msg
  → _commit_inbound_message
  → OLVPetPlatformEvent / AstrBot Event
  → AstrBot Conversation、TTS、Persona hooks
  → OLVPetPlatformAdapter.emit_message_chain
  → OutputSegmentCoordinator
  → output.segment.v6
  → 前端 TurnPlaybackSessionStore
  → TurnPlaybackOrchestrator
  → PlaybackTimeline / ModelEngine / Live2D
```

这条链路有两个已经稳定的部分：

1. `protocol/` 是相对干净的边界，当前协议清单以 `schema_manifest.json` 为准。
2. 前端已经将入站段、动作和播放时钟分开，`output.segment.v6` 是当前文本、音频和动作汇合点。

仍然存在的主要耦合：

| 位置 | 当前问题 | 目标归属 |
| --- | --- | --- |
| `platform_adapter.py` | 组装 RuntimeState、媒体、WebSocket、历史、语音和 TurnCoordinator，既是平台类又是组合根 | 保留为平台组合根，逐步只负责注入 Adapter 与运行时能力 |
| `runtime/turn_coordinator.py` | 仍处理协议路由、AstrBot 事件提交、VAD、媒体和输出回执；业务 Turn 终态、活动事件和计时已由 `InteractionOrchestrator` 持有 | 继续收窄为连接级协议/输入/回执 Adapter；AstrBot 提交和事件转换留在 Adapter |
| `main.py` | 约束 AstrBot hooks、TTS 状态、Persona 生命周期、动作生成和插件注册 | 迁移到 AstrBot Adapter/Provider bridge |
| `platform_event.py` | 继承 `AstrMessageEvent`，处理 Persona 分段、TTS 身份和输出投递 | 保留为 AstrBot Conversation Adapter 的实现细节 |
| `runtime/state.py` | 直接解析 AstrBot `Provider`、`STTProvider` 并管理平台配置和模型资料 | 拆成运行配置、Provider Registry、模型资料和诊断几个边界 |
| `services/speech_service.py` | 本地 Streaming ASR 与 AstrBot 消息构造、备用 STT 选择混在一起 | 拆为 STT Provider、语音输入运行时和平台输入转换 |
| `middleware/interaction_motion/` | 依赖 AstrBot Persona Effect、Provider 流和事件上下文 | 以 Motion Provider Port 为核心，AstrBot hooks 作为一种实现 |
| `protocol/` | 已提供 envelope、二进制帧、版本和输出段 DTO | 继续作为跨 Adapter 和前端的稳定边界 |

当前代码中没有发现活动的 `<@anim>` 生成或解析路径。生产动作已经走结构化 Motion 和 `output.segment.v6`；残留样例属于文本清洗/透传回归测试，历史审计文档中的旧描述不作为当前实现规范。

## 3. 不变的架构约束

重构期间必须保持以下事实不变：

1. **前端仍然是唯一播放时钟所有者。** Adapter、Orchestrator 和 Provider 不创建第二个音频或动作时钟。
2. **保留当前 Turn 身份语义。** `turn_id`、`message_id`、`sequence`、Persona 分段身份和 TTS 绑定不能因拆层而重新生成或互相替代。
3. **第一阶段不改变 `output.segment.v6` 行为。** 新 Provider 先适配现有协议；只有协议需求明确出现时才评估版本升级。
4. **动作只通过结构化字段传输。** 不恢复 `<@anim>`，不新增文本标记、Prompt 标签或隐式 fallback。
5. **文本、音频和动作的失败可以独立表达。** Provider 失败不能伪造成功，也不能让 Adapter 重新猜测动作或音频状态。
6. **中断和取消必须有唯一 owner。** 每个后台任务、监听器、WebSocket、文件和设备资源都必须由明确的生命周期持有者释放。
7. **领域代码不依赖 AstrBot、WebSocket 或 Electron。** 宿主 API 只能通过窄接口进入 Orchestrator 和 Domain。
8. **不复制 AG99 的宿主能力。** AG99 仍然负责插件、Provider、会话、记忆、认证和宿主生命周期；AG99live 只做身体运行时与连接所需的业务组合。

## 4. 目标契约

接口先作为 Python 内部 Port 和不可变 DTO 设计，不要求第一阶段立刻拆进程或更换语言。

### 4.1 Conversation Provider

Conversation Provider 表示一个可被桌面运行时驱动的对话会话：

```python
class ConversationProvider(Protocol):
    async def send_message(self, request: ConversationInput) -> None: ...
    async def interrupt(self, turn_id: str | None = None) -> None: ...
    async def close(self) -> None: ...
    def subscribe(self, listener: ConversationListener) -> Unsubscribe: ...
```

Provider 事件至少需要能表达：

```text
turn_started
text_delta / text_completed
segment_boundary
turn_completed / turn_failed / interrupted
```

`segment_boundary` 只表示上游认为这里可能形成新的逻辑消息段；它不能直接生成 `OutputSegment` 或 `output.segment.v6`。最终的段身份、段聚合和发布只能由 Interaction Orchestrator 完成。


Platform Adapter 与 Conversation Provider 是两个不同的接口：

```text
Platform Adapter
  连接、认证、平台身份、会话映射、宿主生命周期

Conversation Provider
  send_message、回复流、会话中断、对话事件
```


### 4.2 STT Provider

```python
class SttProvider(Protocol):
    async def start_session(
        self,
        stream_id: str,
        options: SttSessionOptions | None = None,
    ) -> None: ...
    async def push_audio(self, stream_id: str, chunk: bytes) -> None: ...
    async def finish_session(self, stream_id: str) -> SttResult: ...
    async def cancel_session(self, stream_id: str) -> None: ...
    def on_partial(self, listener: PartialTranscriptListener) -> Unsubscribe: ...
    def on_final(self, listener: FinalTranscriptListener) -> Unsubscribe: ...
```

`stream_id` 是输入流的唯一 owner key，必须覆盖重复停止、重连、迟到音频和并行流。`push_audio` 最终应使用异步有界队列或等价的背压策略，并明确消费不过来时是阻塞、丢帧、终止还是报告错误。

现有 sherpa-onnx Streaming ASR 是第一候选实现。AstrBot 的 STT 只能作为另一种 Provider 实现，不能继续成为 Orchestrator 的隐式全局依赖。

### 4.3 TTS Provider

```python
class TtsProvider(Protocol):
    async def synthesize(self, request: TtsRequest) -> TtsResult: ...
    async def cancel(self, request_id: str) -> None: ...
```

```python
@dataclass(frozen=True)
class AudioArtifact:
    artifact_id: str
    uri: str
    format: str
    duration_ms: int | None = None
    sample_rate: int | None = None


@dataclass(frozen=True)
class TtsResult:
    request_id: str
    artifact: AudioArtifact | None = None
    phoneme_cues: tuple[PhonemeCue, ...] = ()
```

Provider 可以在内存中生成音频，也可以先写入缓存，但返回 Orchestrator 的必须是统一的 `AudioArtifact`。Provider 负责创建和报告 artifact，Media/Artifact owner 负责 URI 的可用期、缓存清理和取消后的回收；Orchestrator 不直接管理字节或文件。

`artifact` 与 `phoneme_cues` 至多各有一个结果形态；如果 Provider 同时拥有内存数据和 URL，必须在适配层选定一个 artifact，不能把两种存储语义继续暴露给 Orchestrator。`duration_ms` 可以由 Provider 提供，也可以由 Media 层补齐，但来源必须可诊断。


### 4.4 Motion Provider

```python
class MotionProvider(Protocol):
    async def generate(self, request: MotionRequest) -> MotionResult: ...
    async def cancel(self, request_id: str) -> None: ...
```

Motion Provider 只输出语义动作，不直接写 Cubism 参数：

```json
{
  "intent_tags": ["疑惑", "轻微调侃"],
  "axis_levels": {
    "head_yaw": 3,
    "body_yaw": -2,
    "head_roll": 3,
    "brow_bias": 3
  }
}
```

现有 Persona Effect、独立动作 Provider 和被动动作 Provider 都可以先作为实现接入。ModelEngine 继续在前端负责语义校验、参数编译和轨迹执行。

Turn 动作和被动动作必须区分来源：

```text
Turn Motion
  有 turn_id/message_id
  关联文本或音频
  受当前交互中断

Passive Motion
  不创建正式 Turn
  不进入聊天输出队列
  在 PTT、VAD 或新输入时取消
```

可以共用 Motion DTO，但请求必须带 `origin = turn | passive`；如果生命周期或取消语义继续不同，则保留 `PassiveBehaviorProvider` 独立接口。被动动作不能影响 `synth_finished` 或 `turn_finished`。

### 4.5 Avatar Output Port

Orchestrator 不直接依赖 WebSocket，而是依赖一个输出端口：

```python
class AvatarOutputPort(Protocol):
    async def publish_segment(self, segment: OutputSegment) -> None: ...
    async def publish_control(self, event: ControlEvent) -> None: ...
    async def publish_error(self, error: ProtocolError) -> None: ...
```


## 5. 目标模块边界

不要求一次性移动全部目录。优先按依赖方向收敛：

```text
protocol/
  DTO、schema、parser、builder、错误码

runtime/
  turn、segment、session、orchestrator、playback-facing lifecycle

providers/
  conversation、stt、tts、motion 的 Port 和实现

adapters/

transport/
  WebSocket、静态资源和未来其他连接方式

frontend/
  Avatar Runtime、PlaybackTimeline、ModelEngine、桌面 bridge
```

现有 `protocol/`、`runtime/output_segment.py`、`runtime/output_segment_coordinator.py`、`runtime/session_state.py` 和前端播放模块可以作为迁移基线。不要为了目录看起来整齐而先做大规模文件搬迁；先收窄依赖，再移动文件。

## 6. 实施阶段

### Phase 0：冻结事实和建立审计基线

目标：在不改变运行行为的前提下，记录当前可依赖的协议和生命周期事实。

工作内容：

- 以 `protocol/schema_manifest.json`、生成的 TypeScript 类型和现有协议文档作为唯一协议基线。
- 记录输入、输出、TTS、动作、打断、断连和播放完成的身份关系。
- 为一条成功文本回复、一条带 TTS 的回复、一条动作失败回复和一条被打断回复记录黄金事件序列；至少覆盖 `input.text`、`turn_started`、文本完成、TTS、Motion、`output.segment.v6`、`control.synth_finished`、`control.playback_finished` 和 `control.turn_finished`。
- 同时记录输入到 STT partial、STT final 到 Conversation 首 token、首 token 到首个 TTS、TTS 到 `output.segment`、`output.segment` 到前端起播的时间点；这些是后续判断 Provider 解耦是否改善延迟的基线，不把 Port 本身当作性能优化。
- 标记 AstrBot 依赖入口：`main.py`、`platform_adapter.py`、`platform_event.py`、`runtime/state.py`、`services/speech_service.py`。
- 将 `<@anim>` 旧路径标记为历史兼容清理项，不新增任何兼容分支。
- 建立一条当前 AstrBot 模式的端到端验收脚本或可复用日志样本，作为后续重构对照。

完成标准：不改协议、不改前端、不改运行行为，能够从源码和日志解释一轮输入如何成为一个或多个 `output.segment.v6`。

### Phase 1：建立内部 Port 和中立 DTO

目标：先定义职责，不改变现有调用者。

工作内容：

- 新增 Conversation、STT、TTS、Motion 和 Avatar Output 的最小接口。
- 为请求、结果、事件、取消和失败定义结构化 DTO。
- 明确哪些字段属于 Turn、Segment、Provider request 和协议 payload。
- 把现有 AstrBot 实现包成第一批 Adapter/Provider 实现。
- Provider 只能通过接口返回结果，不能直接调用 `send_json`、生成 `output.segment.v6`、修改前端状态或写入另一个 Provider 的内部状态。
- 将 `segment_boundary` 定义为 Orchestrator 的输入事实，而不是 Provider 生成的最终 Segment。

完成标准：现有 AstrBot 链路仍然可运行；Orchestrator 的新接口可以在单元级接收假的 Conversation、STT、TTS 和 Motion Port；没有 Provider 直接生成或发布 `output.segment.v6`，也不增加兼容双路径。

### Phase 2：抽出 Interaction Orchestrator

目标：将 Turn、Segment 和输出终态从 AstrBot 事件对象中分离出来。

工作内容：

- 已从 `TurnCoordinator` 中抽出并由 `InteractionOrchestrator` 持有与平台无关的 Turn/Segment 事实和终态注册表；后续继续减少协议编排器对这些事实的直接读写。
- 保留 `turn_id`、`message_id`、`sequence`、Persona 分段索引和 TTS 身份绑定规则。
- 将 `build_platform_event`、`commit_event`、AstrBot-specific hook 调用移到 AstrBot Adapter。
- 将 `OutputSegmentCoordinator` 改为消费 Provider 事件和中立 DTO；它或其后继 `SegmentAssembler` 是唯一创建最终 Segment 和 `output.segment.v6` 的组件。
- 先在一个外部 `InteractionOrchestrator` 中按 `TurnLifecycle`、`SegmentAssembler`、`ProviderEventRouter`、`CancellationRegistry` 和 `OutputPublisher` 划分职责，不立即把每个职责搬成独立文件。
- 将打断、取消、连接断开和迟到输出统一收口到 Orchestrator 的 owner。
- 保持前端 `output.segment.v6`、`output.segment_motion`、`control.synth_finished` 和 `control.turn_finished` 行为不变；`control.playback_finished` 仍然只能来自前端，Orchestrator 只消费并结算它，不能自行伪造播放完成。

完成标准：Orchestrator 可以在不实例化 `AstrMessageEvent` 的情况下完成一轮中立的 Turn/Segment 生命周期测试；AstrBot 仍可通过 Adapter 驱动同一条输出链路。

### Phase 3：先验证 Conversation，再抽出能力 Provider

Phase 2 稳定后，先做一个只处理文本的 `AstrBotConversationProvider`，验证 Orchestrator 已经可以不实例化 `AstrMessageEvent` 就完成对话事件到输出段的收口。它暂时可以继续桥接现有 AstrBot TTS 和 Motion，但不能让 Conversation Provider 直接生成最终 Segment。

随后按以下顺序抽出能力 Provider：

1. **STT**：将 sherpa-onnx 流式识别和 AstrBot STT 适配为两个 Provider；语音输入运行时只依赖 `SttProvider`，并固定 `stream_id`、取消和背压语义。
2. **TTS**：先适配 AstrBot TTS 生命周期，保留现有音频缓存和段身份；用 `AudioArtifact` 固定音频资源所有权，再补充本地或远程实现。
3. **Motion**：把 Persona Effect 和独立动作 Provider 统一成 Turn Motion Provider；被动动作保留独立生命周期或显式 `origin=passive`，不进入对话 Turn 收口。

这里的“抽出”是依赖方向变化，不要求每个 Provider 立即成为独立进程。

完成标准：Orchestrator 不再直接引用 AstrBot 的 `Provider`、`STTProvider`、`AstrMessageEvent` 或宿主 TTS 状态；AstrBot 仍能提供等价能力；Turn Provider 与 Passive Provider 不会共享同一个 Turn 终态。

### Phase 4：收窄 AstrBot Platform Adapter

目标：让平台 Adapter 只负责连接和转换。

工作内容：

- 将 AstrBot 注册、平台配置、会话身份、事件转换、宿主 hooks 和 Provider 选择集中到 `adapters/astrbot` 边界。
- 保留 Adapter 实例的组合根和清理责任，但不在其中实现播放、动作编译或 TTS 规则。
- 将 RuntimeState 拆成运行配置、模型/Live2D 资料、Provider Registry 和诊断投影。
- 将 WebSocketTransport 只保留传输职责；业务分发通过 Orchestrator Port 完成。
- 继续使用 AG99 宿主的插件生命周期和 Provider 管理，不复制第二个 PluginManager。

完成标准：没有 AstrBot 的纯协议/Turn/Segment 测试可以运行；AstrBot Adapter 只提供平台转换和能力绑定。

### Phase 5：按真实约束决定进程化

只有逻辑接口稳定并有真实延迟、资源和部署数据后，才评估：

- sherpa-onnx 是否继续作为 Python 服务；
- TTS 是否独立进程；
- Motion Provider 是否切换到本地小模型服务；
- Standalone/LocalModel Provider 是否需要独立部署。

进程化不是本计划的前置条件，也不能改变唯一的 Turn/Segment 和播放终态规则。

## 7. 删除与清理项

以下内容属于一次性清理，不应保留第二条旧路径：

- `<@anim>` 生成、解析、Prompt 要求和 fallback；
- 文本清洗中针对动作标记的特殊分支；
- 文档中把 `<@anim>` 描述为官方兼容动作入口的旧说明；
- 只为旧传输路径存在的测试断言；
- Adapter 内部把文本标记重新解释为动作的隐式逻辑。

测试中若需要验证“普通文本不会被当作动作协议”，应改成明确的拒绝或原样保留边界测试，而不是继续把旧标记当作有效传输样例。

## 8. 验证策略

重构不是以“所有单元测试通过”作为唯一证据。每个阶段至少需要：

### 静态验证

- Python 编译和类型/导入检查；
- TypeScript 类型检查；
- `scripts/check_protocol_schema_manifest.py`；
- 依赖扫描，确认 Domain/Orchestrator 没有反向导入 AstrBot、WebSocket 或 Electron；
- 变更后的协议文档和生成类型一致。

### 最小边界检查

- 一条文本输入成功完成一个 Turn；
- 一条输入被打断并正确发送终态；
- 一段文本和音频成功形成一个 `output.segment.v6`；
- 动作 Provider 失败时，文本和音频仍按明确失败状态收口；
- `segment_boundary` 只能导致 Orchestrator 创建一个候选段，Provider 不能直接发布 `output.segment.v6`；
- TTS 失败、Motion 迟到、连接断开和重复回调不会产生第二个 Turn 或第二个播放时钟。

### 真实运行验收

每完成一个跨边界阶段，都需要在真实 AG99、对应 Provider、TTS、Electron 和 Live2D 环境中确认：

- 首段延迟和后续段顺序；
- 文本、音频、字幕、口型和动作的同步；
- 打断、重连和迟到 Provider 结果；
- 多轮会话和会话切换；
- Web 控制台和 Motion Lab 的诊断是否仍能定位同一身份。

如果没有真实运行条件，只能报告源码和边界 smoke check 结果，不能以更多 mock 测试替代。

## 9. 风险与处理

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| Turn 身份在 Provider 之间重新生成 | 段顺序、打断和播放完成错乱 | Orchestrator 统一生成并绑定身份，Provider 只携带关联 ID |
| Conversation Provider 直接生成 Segment | 段重复发布、TTS/Motion 无法汇合 | Provider 只报告文本和 `segment_boundary`，Segment 只能由 Orchestrator 收口 |
| STT 没有流标识或消费背压 | 迟到音频、并行流和重连造成串流或内存增长 | 所有音频操作带 `stream_id`，内部使用有界队列并定义过载策略 |
| 音频资源没有唯一 owner | 缓存泄漏、重复删除或播放期间文件失效 | Provider/Media 创建 `AudioArtifact`，由明确的 artifact owner 管理 URI 生命周期 |
| Motion Provider 直接写前端 | 破坏 ModelEngine 和播放时钟边界 | Motion 只返回语义 payload，统一经输出段发布 |
| 被动动作混入 Turn 生命周期 | idle 动作影响对话终态或无法被 PTT 打断 | 使用独立 PassiveBehaviorProvider 或显式 `origin=passive`，不创建正式 Turn |
| 迁移时保留两套输出路径 | 结果重复、终态不确定 | 每迁移一个能力就统一调用者，删除旧内部路径 |
| 过早拆成多个进程 | 延迟、取消和诊断复杂化 | 先逻辑分离，后基于真实数据决定进程边界 |
| 文档把计划写成现状 | 后续实现误判 | 本文标记为“设计/计划”，当前事实仍以源码和实现文档为准 |

## 10. 暂不做的事

- 不立即重命名或搬迁全部现有目录；
- 不立即升级 `output.segment.v6`；
- 不建立新的 AG99live PluginManager、ConversationManager 或认证系统；
- 不把所有 Provider 拆成独立服务；
- 不把模型动作语义编译搬到后端或 Platform Adapter；
- 不恢复 `<@anim>` 或任何文本动作标记；

## 11. 完成定义

当以下条件全部满足时，才认为这次重构目标达成：

1. Orchestrator 不依赖 AstrBot 的事件类、Provider 基类或 WebSocket 实现。
2. STT、TTS、Motion 都有明确输入、输出、取消和失败契约。
3. Platform Adapter 只负责平台连接、会话转换和 Provider 绑定。
4. 前端仍然是唯一播放时钟和 Live2D 执行者。
5. `<@anim>` 不再出现在活动协议、Prompt、解析器或 fallback 中。
6. 真实运行日志可以用同一组身份解释输入、Provider 结果、输出段和播放终态。

## 12. 当前下一步

后续代码变更应围绕真实宿主验收和边界收窄：

1. 在真实 AstrBot 配置中验证主动 TTS、主动 Motion、STT stream 和取消顺序；
2. 将 `main.py` 的宿主 hooks 继续收窄到 `adapters/astrbot`，保持现有生命周期事实和输出协议；
3. 保持 `output.segment.v6`、前端和现有 AstrBot 行为不变，并记录真实延迟与迟到 Provider 结果；
4. 只有真实验收完成后，才评估是否需要移动 `runtime/state.py` 或进程化 Provider。

只有这一步稳定后，才开始移动 `main.py`、`platform_event.py` 和 `runtime/state.py` 中的 AstrBot 专属逻辑。
