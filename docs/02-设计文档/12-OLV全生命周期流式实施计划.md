# OLV 全生命周期流式实施计划

> **状态：实施前计划稿，待评审。**本文描述拟实施路线，不代表相关能力已经进入源码。范围覆盖 AstrBot Core、AG99live Adapter Python 后端和 TypeScript 桌面前端；不涉及 C++。

## 目标

让 OLV 的一轮语音交互从桌面采集到桌面播放都能按增量推进：

```text
PCM 麦克风帧
  -> 流式 ASR 的临时/最终转写
  -> AstrBot 正常会话与 Persona 生成
  -> 已校验 Persona segment
  -> 动作与 TTS 并行准备
  -> TTS 音频帧经 Adapter 送达桌面
  -> TypeScript 播放队列驱动音频、字幕、口型和动作
```

第一版以**完整且通过校验的 Persona segment**作为可见、可合成和可播放的最小单位。模型 token 或尚未闭合的 segment 不直接送入 TTS，避免已播内容无法撤回，以及动作与文本失去稳定关联。ASR 临时结果可以显示，但第一版只将最终转写提交为一条正常 AstrBot 输入，不因每次修订重复触发对话。

主要体验指标是“用户停止说话至桌面首个可听音频”的耗时，同时记录临时转写、最终转写、首个 Persona segment、首个 TTS 音频帧和桌面实际起播时间。先建立当前路径的基线，再设定量化目标；不在缺少实测基线时承诺固定毫秒数。

## 当前基础与缺口

| 环节 | 已有基础 | 主要缺口 |
| --- | --- | --- |
| 麦克风上行 | TS 已分块发送 PCM，Adapter 已解析带序号的二进制输入帧；VAD 可逐帧检测。 | PTT 会缓存到音频结束；VAD 也在完整语音段形成后才调用 STT。 |
| ASR | AstrBot `STTProvider.get_text(audio_url)` 和文件型 STT 实现可用于最终识别。 | 没有统一的音频会话/增量识别接口；当前 MiniMax STT 适配器上传完整文件并读取完整文本。 |
| Persona | Core 已有 `segment_stream_v1` 的模型流读取和结构化解析原型。 | 生成和输出路径受 WebChat、配置及钩子兼容条件限制；AG99live 的独立动作入口目前依赖完整 Persona 结果钩子。 |
| 分段动作与输出 | Adapter 已有 Turn、顺序、动作 Future 和逐段 flush 机制；工作区中的改动扩展了 Persona 分段交付。 | 当前逐段准备仍可能始于完整 Persona 结果到达后；部分关联字段要求提前知道总段数。 |
| TTS | `TTSProvider` 已定义 `get_audio_stream()`；Agent 路径已有流式 TTS 消费代码，MiniMax TTS 适配器内部使用上游 SSE。 | Persona 通用语音服务仍调用 `get_audio()` 并物化完整文件；现有流接口的字节格式不足以直接充当桌面连续音频协议。 |
| 桌面下行与播放 | WebSocket 已支持双向消息循环；TS 有原子 `output.segment.v5`、播放时间线和口型同步。 | Adapter 出站抽象目前只发送 JSON；TS 播放器按完整音频 URL 创建 `HTMLAudioElement`，没有接收音频帧的缓冲播放状态。 |

`passive_behavior` 的 NDJSON 动作流可作为 Provider 流读取、校验、序号、取消和 Turn 收口的参考；它是后台动作路径，不承担普通对话和语音生命周期。

## 目标职责与身份

- **AstrBot Core**拥有正常会话、Turn、模型 Provider 流、Persona 解析和 segment 校验；每个可发布 segment 只在完整验证后进入 OLV 输出链。Core 在流结束时发布最终段数和 Turn 终态。
- **AG99live Adapter**沿用现有 TurnCoordinator、动作生成、输出顺序和连接清理职责；为每个已校验 segment 并行动作与 TTS，把音频帧按序写入当前 WebSocket 连接，并传播背压、失败和取消。
- **TypeScript 前端**拥有 Turn/segment 播放状态、有限容量的音频队列、桌面音频输出和现有 PlaybackTimeline；以实际输出音频的时钟驱动口型和动作，不另建第二个播放时钟。
- 全链路使用 `turn_id`、`persona_result_id`、`segment_index`、逻辑 `message_id` 和音频 `stream_id` 关联。流开始时只要求 segment 索引单调递增；总段数在流结束时确定。
- 动作任务与该段 TTS 并发。为保留现有动作/音频同步边界，首段在动作结果和首个可播放音频帧均就绪后起播，后续音频帧到达后连续入队。播放顺序由 segment 序号决定，不由 Provider 完成先后决定。

## 实施阶段

### 阶段 0：冻结契约与建立基线

1. 记录当前端到端延迟及各阶段时间戳，确认目标 TTS、聊天 Provider 和实时 ASR Provider。
2. 冻结 OLV 流式事件的状态机、身份字段、音频编码、格式元数据、队列上限、背压行为及终态规则。
3. 为协议选独立的流式 schema/事件，不改变 `output.segment.v5` 的完整原子段语义。明确 Adapter 与桌面端按配套版本升级；若需要旧桌面端并行运行，再单独定义显式能力协商。
4. 确认 Core 流式 Persona 的适用配置，以及 OLV 所需 Persona/动作钩子的逐段调用契约。

**完成条件：**协议草案覆盖 start/chunk/end、segment/Turn 完成、错误、中断和断线；首响基线可从真实日志计算；Provider 选择和格式假设有依据。

### 阶段 1：Core 到 Adapter 的 Persona segment 流

1. 把现有 `segment_stream_v1` 解析接入 OLV 的正常 Turn 输出路径，不复制一套对话队列或会话处理。
2. Core 在 `segment_end` 完成结构校验后发布该段文本、动作意图、tendency 和稳定身份；流结束时统一发布最终计数及成功/失败状态。
3. 将 AG99live 当前依赖 `OnPersonaExpressionResultEvent` 的动作生成改为逐段登记任务/Future；每段到达即启动动作任务，同时开始该段 TTS。不要等整批 Persona 结果或整批动作完成。
4. 首个垂直切片仍先使用完整段音频文件和现有 `output.segment.v5` 交付，以验证模型 segment 是否在整轮 Persona 结束前抵达桌面。

**完成条件：**真实流式聊天 Provider 下，segment 0 在 Persona Turn 结束前到达 Adapter；文本、动作与 TTS 关联正确；段序不受任务完成顺序影响；中断后晚到结果不能重开 Turn。

**约束：**当前 Core 流式原型要求特定结构化输出模式，并拒绝部分全局钩子/输出贡献者，且不支持 Persona effects。阶段 0 必须明确 OLV 实际依赖哪些能力；所需钩子必须被纳入逐段契约或明确列为启用限制，不能静默跳过后宣称兼容。

### 阶段 2：TTS 音频帧到桌面连续播放

1. 在 Persona segment 路径调用 Provider 的流式 TTS 接口；确认提供商发出的是原始媒体片段、独立 WAV 片段还是其他格式。按阶段 0 冻结的桌面格式规范化输出。
2. Adapter 增加有界音频发送队列及 WebSocket 二进制下行帧；每帧包含 Turn/segment/stream 身份、单调 chunk 序号和必要格式元数据。禁止无界积压和静默丢帧。
3. TypeScript 增加每段有限缓冲和连续音频输出能力，集成现有 PlaybackTimeline。只有收到 stream end 且缓冲播放完毕，音频 sink 才进入完成终态。
4. 保持 `output.segment.v5` 用于现有完整段路径；新流式路径使用阶段 0 定义的独立协议契约。不得把“完整 URL”字段改成含义不明的半成品数据。
5. 语音、字幕和动作以同一个 segment/音频时钟同步；Turn 中断时清空该 Turn 未播放帧并取消 Provider 任务。

**完成条件：**首个音频帧在该段 TTS 尚未全部生成、整轮 Persona 尚未结束时已开始播放；慢网络能产生背压或明确失败；结束和中断均正确释放播放、口型与动作资源。

### 阶段 3：流式 ASR 输入

1. 为 STT Provider 定义音频会话生命周期：开始、PCM 帧输入、临时识别、最终识别、取消和失败；同时校验 `stream_id`、采样率、声道及帧顺序。
2. Adapter 收到麦克风帧后即送入已选实时 ASR 会话；临时识别允许修订，只更新转写显示，不创建多条聊天消息。最终识别只提交一次现有 AstrBot 消息。
3. 统一 PTT 与 VAD 的句段边界和 Turn 归属；新输入触发既有打断策略，并取消旧的识别、模型、TTS 和桌面播放工作。
4. 不把“上传完整音频文件后返回 SSE”当作麦克风实时 ASR；实时能力必须由选定 Provider 的接口和真实运行证明。

**完成条件：**采集期间收到可修订的部分文本，句段结束后得到唯一最终文本并只触发一条对话；丢帧、重连、空音频及取消有明确终态。

### 阶段 4：端到端验收与启用

按配套 AstrBot、Adapter 和 Electron 版本进行真实运行验收，覆盖至少双段回复、Provider 变慢/失败、ASR 修订、动作迟到、音频队列背压、PTT 打断、VAD 打断和 WebSocket 断线。确认音频播放时钟、字幕、口型、动作段序和 `turn_finished`/播放完成回执一致。

采集 p50/p95 的“停止说话至首个临时转写、最终转写、首个 Persona segment、首个音频帧、实际首响”时间，并与阶段 0 基线比较。功能验收要求确认音频实际在整轮生成/合成结束前起播；单元测试、类型检查和协议清单检查不能代替这项真实验收。

## 失败、中断与资源规则

- 已经播放的 segment 不回滚；流后续失败时发送明确的 segment/Turn 失败终态，保留已播放前缀，不伪装成完整成功。
- 取消以 `turn_id` 为界，取消 Core Provider 流、该 Turn 的动作任务、TTS Provider、发送队列和桌面缓冲；迟到消息按已终止身份拒绝。
- 每个排队点都设置容量和明确的超限行为。音频是不可丢弃的连续数据，禁止像普通 UI 状态更新一样合并或静默丢弃。
- 错误和终态由唯一生命周期所有者收口；`control.synth_finished` 表示后端已停止产出，桌面播放完成仍以本地音频队列耗尽及相关动作终态为准。

## 待评审决策与非目标

1. 确认第一阶段 Persona 流式模式可接受的 Core 配置、钩子和 effect/tool 限制，以及 AG99live 动作钩子逐段迁移方式。
2. 选定首个实时 ASR Provider；现有文件型 STT 不满足此能力。
3. 冻结音频采样率、声道、编码及二进制帧格式；优先选择能被桌面低延迟连续解码、且 Provider 可稳定产出的格式。
4. 确认流式功能初期是否通过显式配置启用，以及 Adapter 与桌面端的配套版本策略；不因 Provider 不支持而静默切回整段路径。
5. 第一版不基于临时 ASR 文本推测启动模型。此类提前执行要先解决识别修订、撤销和副作用隔离，待真实延迟数据证明收益后再评估。
6. 不修改 C++ 原生运行时，不建立第二套聊天 Turn、动作播放器或播放时钟，不改变 `output.segment.v5` 现有语义。
