# useAdapterConnection 收口实施计划

快照日期：2026-05-08

## 一句话目标

本次收口不是为了“把大文件拆小”，而是要把 `useAdapterConnection.ts` 从一个混装层，收成下面三层：

```text
Protocol ingress
-> Adapter event mapping
-> Runtime state/session write + playback facade
```

最终目标是：

- 协议消息只在边界层被 parse / version-check / normalize 一次
- 内部运行时不再反复猜 `turnId / orchestrationId`
- `useAdapterConnection` 不再同时承担“协议解释 + 兼容映射 + 播放组匹配 + UI 回填”的全部职责

## 当前文件现状

当前文件：

- [useAdapterConnection.ts](</c:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/composables/useAdapterConnection.ts>)

当前它大致混合了五类职责：

1. 连接管理
   - `initialize`
   - `connect`
   - `disconnect`
   - `openConnectionCandidate`
2. 麦克风 / 音频播放
   - `toggleMicrophoneCapture`
   - `startMicrophoneCapture`
   - `stopMicrophoneCapture`
   - `playAudioAndAcknowledge`
   - `stopAudioPlayback`
3. 协议消息接入
   - `handleSocketMessage`
   - `applyOutputText`
   - `applyOutputAudio`
   - `applyTurnFinished`
   - `applyControlError`
4. 本地播放队列与 release
   - `queueAssistantTextForPlayback`
   - `releaseAssistantTextForPlayback`
   - `queueAudioForPlayback`
   - `releaseAudioForPlayback`
   - `matchesPlaybackGroup`
5. 运行态和 UI 投影
   - `statusMessage`
   - `lastError`
   - `historyEntries`
   - 各种 `pending*` / `turnFinished*` / `audioPlayback*` 字段

问题不在于它大，而在于第 3、4、5 类职责彼此缠在一起。

## 当前最主要的结构问题

## 1. 协议消息进入系统后没有立刻变成“内部定型事件”

现在 `ProtocolEnvelope` 在接入层被直接一路带到各个 `apply*` 函数里。

结果是后续逻辑不断出现：

```text
normalizeOrchestrationId(envelope.orchestration_id) ?? state.currentOrchestrationId
envelope.turn_id ?? state.currentTurnId
```

这说明：

- 上游没有在第一时间解决身份归属
- 下游只能反复补一次

## 2. 兼容映射和运行时规则混在一起

例如：

- `not_requested -> absent`
- `synth_finished_without_audio_playback`
- `turn_finished_without_audio_playback`

这些兼容 / 兜底规则现在混在接入层和运行态状态写入层里，没有统一边界。

## 3. release 层还在自己判断“是不是同一播放组”

典型逻辑：

- `releaseAssistantTextForPlayback()`
- `releaseAudioForPlayback()`
- `matchesPlaybackGroup()`

这意味着：

- 播放编排层已经决定要 release
- 但接入层 facade 还得再猜一遍“你说的是不是我当前这一组”

这让 Session 作为统一真源的收口力度被削弱了。

## 4. `handleSocketMessage()` 既是 ingress，又是 dispatcher，又是业务协调点

它目前同时做：

- JSON parse
- 协议版本校验
- message type switch
- 运行态字段更新
- session store 写入
- 状态文案更新

这会让任何新增协议分支都继续往这个大开关里堆。

## 这次收口的原则

## 1. 保留合理的边界防御

以下 guard 应保留：

- JSON parse 失败
- envelope 不合法
- `version !== PROTOCOL_VERSION`
- payload schema 不匹配
- socket 未连接

这些属于边界层该做的事情。

## 2. 尽量把“兼容映射”收缩到单点

例如：

- `not_requested -> absent`
- 协议字段缺失时的有限 fallback

这类规则不应散落在多个 apply / release 分支里。

## 3. 内部层优先消费“已解决身份”的事件

理想上，进入运行态写入层的事件至少应带：

- `type`
- `turnId`
- `orchestrationId`
- `resolvedSessionKey` 或可稳定解析的 identity
- `payload`

## 4. 不在这次里顺手改动播放语义

这轮只收口结构，不改这些既有语义：

- 文本 / 音频 / 动作的软同步起播规则
- 本地 settled 和后端 `turn_finished` 分离
- Session/Coordinator/Orchestrator 的完成条件

否则风险太高。

## 建议的目标分层

## 第一层：Protocol ingress

建议新职责：

- parse raw websocket message
- 校验 envelope 基本结构
- 校验 `version`
- 输出一个“基础合法”的 inbound envelope

建议模块方向：

- `frontend/src/adapter-connection/inboundProtocol.ts`

建议导出：

- `parseInboundEnvelope(rawData)`
- `isSupportedInboundEnvelopeType(type)`

这层不负责：

- session store
- 状态文案
- 音频 / 文本排队

## 第二层：Inbound event mapping

建议新职责：

- 把 envelope 映射为内部定型事件
- 在这里集中做有限的 identity resolve
- 在这里集中做协议兼容映射

建议模块方向：

- `frontend/src/adapter-connection/inboundEvents.ts`

建议事件类型大致分成：

1. `server_info`
2. `model_sync`
3. `history_*`
4. `motion_tuning_samples_state`
5. `output_text`
6. `output_audio`
7. `output_image`
8. `output_transcription`
9. `turn_started`
10. `turn_finished`
11. `interrupt`
12. `start_mic`
13. `synth_finished`
14. `control_error`
15. `engine_motion_payload`

这里的重点不是建一套超复杂事件系统，而是把：

```text
协议消息
-> 结构化内部事件
```

这一步拉出来。

## 第三层：Runtime apply / facade

建议继续留在 `useAdapterConnection.ts` 的职责：

- 连接生命周期
- 当前 reactive state 暴露
- history adapter / motion tuning adapter 装配
- 内部事件 apply
- 对 orchestrator / coordinator 暴露：
  - `releaseAssistantTextForPlayback`
  - `releaseAudioForPlayback`
  - `sendPlaybackFinishedForCurrentGroup`
  - `clearPlaybackGroupContext`

但这里不再直接吃 `ProtocolEnvelope`，而是吃已经定型的内部事件。

## 本次不建议抽离的部分

为控制风险，这轮不建议连这些一起重构：

- 连接建立与候选地址轮换
- 麦克风采集 runtime
- 音频播放 runtime
- history adapter
- motion tuning adapter

这些可以先原样保留。

## 分阶段实施方案

建议按 4 个阶段做，而不是一次性大改。

## 阶段 1：先把协议入口和 dispatcher 拆出来，不改行为

### 目标

把 `handleSocketMessage()` 的“parse + validate + switch dispatch”框架拆出，但保证行为不变。

### 建议动作

1. 新增 `adapter-connection/inboundProtocol.ts`
   - `parseInboundEnvelope(rawData)`
   - 统一处理：
     - JSON parse 失败
     - envelope 基本结构非法
     - 协议版本不匹配
2. 新增 `adapter-connection/inboundMessageTypes.ts`
   - 收口各类 inbound type 的字面量
3. `useAdapterConnection.ts` 中的 `handleSocketMessage()` 改为：
   - 先调 `parseInboundEnvelope`
   - 再 switch 一个“已验证 envelope”

### 这一阶段不做什么

- 不改 `applyOutputText` / `applyOutputAudio` 的内部逻辑
- 不动 release 逻辑
- 不动 session 写入方式

### 验收标准

- 行为无变化
- `handleSocketMessage()` 明显变薄
- parse / version error 逻辑不再散落在主函数里

## 阶段 2：抽出 inbound event mapping，统一身份解析

### 目标

把 `ProtocolEnvelope -> 内部事件` 的转换拉出来，并减少下游的反复 fallback。

### 建议动作

1. 新增 `adapter-connection/inboundEvents.ts`
2. 给每类关键消息建立最小内部事件结构，例如：

```ts
type InboundAdapterEvent =
  | { kind: "output_text"; turnId: string | null; orchestrationId: string | null; text: string }
  | { kind: "output_audio"; turnId: string | null; orchestrationId: string | null; text: string; audioUrl: string | null }
  | { kind: "turn_started"; turnId: string | null; orchestrationId: string | null }
  | { kind: "turn_finished"; turnId: string | null; orchestrationId: string | null; success: boolean; reason: string }
  | ...
```

3. 在 mapping 层集中处理：
   - `normalizeOrchestrationId`
   - `turn_id ?? currentTurnId` 这类 fallback 的收口策略
   - `not_requested -> absent` 之类兼容语义的边界定义

### 关键原则

这里不要把运行态 `state` 整个塞进 mapper。

可以只给它一个轻量上下文，例如：

- `currentTurnId`
- `currentOrchestrationId`
- `audioPlaybackStartedTurnId`
- `audioPlaybackStartedOrchestrationId`

### 验收标准

- `applyOutputText` / `applyOutputAudio` 等 apply 层不再直接碰原始 envelope
- 文件里 `normalizeOrchestrationId(envelope.orchestration_id) ?? state.currentOrchestrationId` 这类写法明显减少

## 阶段 3：收口 runtime apply，减少双重身份判断

### 目标

让运行态 apply 层只消费内部事件，并进一步收口 session 写入路径。

### 建议动作

1. 把 `applyOutputText`、`applyOutputAudio`、`applyTurnFinished` 等改成接收内部事件
2. 把 “更新 reactive state” 与 “写 sessionStore” 的步骤组织成稳定顺序
3. 把 `control.turn_started` 的大块 state reset 收成独立 helper
4. 把 `control.interrupt` 的清理步骤收成独立 helper

### 推荐的 apply 顺序约束

例如 `output_audio`：

1. resolve identity
2. 更新当前运行态 turn/orchestration
3. 如带 text，写 pending text + session text
4. 如带 audio url，写 pending audio + session audio
5. 更新状态文案

不要每个 apply 各写一套临时顺序。

### 验收标准

- 各类 inbound apply 有统一结构
- session 写入路径更稳定
- state reset / interrupt cleanup 不再埋在 switch 分支里

## 阶段 4：收口 release facade 与播放组判断

### 目标

减少 `releaseAssistantTextForPlayback()` 和 `releaseAudioForPlayback()` 里的“再猜一次身份”。

### 当前现实

现在 orchestrator 调 release 时，仍传：

- `turnId`
- `orchestrationId`

而 facade 内还会拿 `pending*TurnId / pending*OrchestrationId` 再做 `matchesPlaybackGroup()`。

### 建议动作

先不强行删掉 `matchesPlaybackGroup()`，而是分两步：

1. 把它移到更明确的 `playbackQueue` / `playbackRelease` 辅助模块
2. 评估 orchestrator 是否可以直接按 session key 调 release

如果后续 session identity 收口做得够彻底，再考虑：

- 把 release 入参从 `turnId + orchestrationId` 改成 `sessionId` 或稳定 group key

### 验收标准

- release facade 不再和协议接入逻辑纠缠
- 播放组匹配逻辑集中在单点

## 需要补的测试

当前前端已有测试：

- `turnPlaybackOrchestratorCore.test.ts`
- `turnPlaybackSessionStore.test.ts`
- `playbackCompletionCoordinator.test.ts`

但还没有针对 `useAdapterConnection.ts` 的专门测试。

这意味着：

- 这次收口如果完全不补测试，回归风险会偏高

## 建议新增测试方向

### 第一批：纯函数测试

如果阶段 1 / 2 抽出纯函数模块，优先补这些：

1. `parseInboundEnvelope()`
   - 非法 JSON
   - 非法 envelope
   - version mismatch
   - 合法 envelope
2. `mapInboundEnvelopeToEvent()`
   - `output.text`
   - `output.audio`
   - `control.turn_started`
   - `control.turn_finished`
   - `control.synth_finished`
   - `engine.motion_*`

这些测试值很高，因为它们最能保护“拆结构不改语义”。

### 第二批：轻量 useAdapterConnection 集成测试

建议至少覆盖：

1. `output.text` 到来后：
   - pending text 被写入
   - session text 被写入
2. `output.audio` 到来后：
   - pending audio 被写入
   - session audio 被写入
3. `turn_started` 到来后：
   - pending 状态被 reset
   - active session 被设置
4. `turn_finished` 到来后：
   - session backend.turnFinished 被写入
   - no-audio 情况下音频终态被补成 absence 语义

### 测试落地建议

可以沿用当前 `frontend/tests/*.test.ts` 的风格，把 test include 扩到新的 `adapter-connection/*.ts`。

## 风险与控制

## 风险 1：一边拆，一边偷偷改了播放语义

控制方法：

- 每一阶段只做一层职责收口
- 不同时改 orchestrator / coordinator / session rule

## 风险 2：identity fallback 改坏，导致晚到 motion / no-audio turn 出问题

控制方法：

- 把 identity 解析规则单列成函数和测试
- 先保持旧规则，后面再缩紧

## 风险 3：文件是拆了，但复杂度只是横向搬家

控制方法：

- 每次拆分都要看“职责是否更清楚”
- 不是只追求行数下降

## 具体建议的落地顺序

如果我们马上开工，我建议按这个最稳的顺序来：

1. 先做阶段 1
   - 抽 `parseInboundEnvelope`
   - 不改行为
2. 再做阶段 2
   - 抽 inbound event mapping
   - 补纯函数测试
3. 再做阶段 3
   - apply 层改吃内部事件
4. 最后做阶段 4
   - 收口 release facade

## 这份计划的验收方式

这份计划本身如果成立，应该满足：

1. 每一阶段都能单独提交
2. 每一阶段都能单独验证
3. 即使做到一半，也不会把当前播放链路结构搞乱
4. 最后能明确改善下面三件事：
   - `useAdapterConnection.ts` 文件职责更清晰
   - identity fallback 显著减少
   - compatibility mapping 的单点边界更明确

## 下一步

建议下一步直接执行：

```text
阶段 1：抽 parse / validate / inbound dispatcher
```

这是最稳的一刀，收益明确，且最不容易把文本 / 音频 / 动作主链路改坏。
