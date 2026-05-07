# 前端 Turn Playback Session 收口计划

快照日期：2026-05-07

## 1. 背景

当前前端已经具备以下能力：

- `useTurnPlaybackOrchestrator` 负责文本 / 音频 / 动作的起播软同步
- `usePlaybackCompletionCoordinator` 负责文本 / 音频 / 动作的完成判定
- `useAdapterConnection` 负责协议消息接入、pending 缓存和部分播放状态推进
- `useModelEngine` 负责动作载荷排队、等待音频、编译和启动播放

这些能力单点上都成立，但它们没有围绕同一个前端“轮次对象”协作。

当前“同一轮播放”的状态被拆散在多处：

- `currentTurnId / currentOrchestrationId`
- `pendingAssistantText*`
- `pendingAudio*`
- `inboundMotionPlan*`
- `audioPlaybackStarted*`
- `audioPlaybackTerminal*`
- `assistantTextDelivery*`
- `turnFinished*`
- `playbackCoordination.*`
- `pendingInboundMotionPayloads`（位于 `useModelEngine.ts`，不属于 adapter 字段）

结果是：

1. 同一轮的语义在多个模块里各自保存一部分
2. 模块之间通过 `nonce + watch + fallback` 间接拼接
3. 每个局部实现都能解释，但组合起来不像一个统一系统
4. 后续改一处轮次语义时，容易漏改其他模块

本计划的目标，是把这些已经存在的素材收口成前端的一等公民概念：

**Turn Playback Session**

也就是：

**同一轮回复从“收到文本 / 音频 / 动作”到“全部播放完成”的唯一前端会话对象。**

## 2. 核心目标

本次收口必须达成以下目标：

1. 前端存在明确的 `TurnPlaybackSession` 类型
2. 文本、音频、动作、后端轮次状态都挂在同一个 session 下
3. 起播编排只围绕 session 运转
4. 完成判定只围绕 session 运转
5. `ModelEngine` 不再长期维护平行的“待播轮次语义”
6. 旧的散装轮次字段最终被收缩或删除

## 3. 非目标

这次不做以下事情：

1. 不做音素级音频 / 口型同步
2. 不重写 `ModelEngine` 编译逻辑本身
3. 不改后端 turn coordinator 的协议语义
4. 不顺手重做 bridge / settings / Action Lab 全部结构
5. 不把长期事实重新持久化到前端 localStorage

## 4. 设计原则

### 4.1 单一真源

前端对“这一轮播放现在到了哪一步”的唯一事实来源，必须是 `TurnPlaybackSession`。

### 4.2 事件驱动，状态收口

- `useAdapterConnection` 负责接协议事件
- session store 负责把事件落到 session 上
- orchestrator / completion / model engine 只消费 session

### 4.3 后端真源边界不被破坏

本次收口仅处理前端运行时播放轮次，不改变“后端 canonical profile 才是事实来源”的边界。

### 4.4 渐进迁移

先“双写”，后“切读”，最后“删旧字段”。

不做一次性大爆改。

## 5. Session 模型

### 5.1 Session 主键

前端播放轮次的主键优先使用：

```text
orchestrationId
```

原因：

- 前端发送时已经会生成一个稳定 UUID
- 它不参与大模型判断
- 但它足够稳定，可以贯穿文本、音频、动作和播放完成回执

`turnId` 仍保留，但作为后端轮次补充字段，不作为第一优先主键。

为避免实现阶段出现歧义，这里明确 session id 解析优先级：

1. `orchestrationId` 存在  
   -> `session.id = orch:<orchestrationId>`
2. `orchestrationId` 不存在，但 `turnId` 存在  
   -> `session.id = turn:<turnId>`
3. 两者都不存在  
   -> `session.id = ephemeral:<serial>`

补充约束：

- `ephemeral session` 只用于本地短生命周期兜底
- 它不作为长期可回溯的轮次标识
- 第一版不做 `ephemeral -> named session` 的升级迁移
- 一旦 session 以某种 id 创建，当前轮次内保持不变

### 5.2 建议类型

建议新增：

```text
frontend/src/turn-playback/session.ts
```

示意结构：

```ts
export type TurnPlaybackPhase =
  | "collecting"
  | "ready"
  | "playing"
  | "settling"
  | "completed"
  | "failed";

export interface TurnPlaybackSession {
  id: string;
  turnId: string | null;
  interrupted: boolean;

  text: {
    content: string | null;
    receivedAtMs: number | null;
    receiveMode: "replace" | "append";
    released: boolean;
    delivered: boolean;
  };

  audio: {
    url: string | null;
    receivedAtMs: number | null;
    started: boolean;
    startedAtMs: number | null;
    durationMs: number | null;
    terminal: "idle" | "completed" | "failed" | "absent";
    reason: string;
  };

  motion: {
    payload: NormalizedMotionPayload | null;
    receivedAtMs: number | null;
    started: boolean;
    completed: boolean;
  };

  backend: {
    turnStarted: boolean;
    turnFinished: boolean;
    success: boolean | null;
    reason: string;
  };

  phase: TurnPlaybackPhase;
}
```

### 5.3 字段语义要求

必须把现有混淆语义拆开：

- `audio.terminal = "absent"` 只表示“本轮明确没有音频”
- 不再让 `not_requested` 同时承担“没排到 / 没有音频 / 可当终态”三种语义
- `backend.turnFinished` 只表示“后端这一轮输出已收口”
- 不再让它同时承担前端播放完成含义
- `interrupted = true` 表示本轮被中断，且这是一个显式终止原因，不与普通失败混写

### 5.4 流式文本累积规则

当前前端的 `pendingAssistantText` 更接近“当前轮次最新完整文本快照”，而不是逐 chunk 的纯增量缓冲。

因此第一版 `TurnPlaybackSession` 规定：

- `text.content` 保存当前轮次的最新文本值
- `markTextReceived(text, mode)` 支持两种模式：
  - `replace`
  - `append`
- 当前默认实现使用：
  - `replace`

也就是说：

- 如果收到多次 `output.text`
- 默认按“最新完整文本快照覆盖旧值”处理
- 不默认做盲目 append

后续只有在后端明确切换为增量文本流协议时，才启用 `append` 路径。

### 5.5 中断规则

`control.interrupt` 必须在 session 语义中有明确含义。

规则如下：

1. interrupt 不负责创建新 session
2. 当前 active session 在收到 interrupt 时：
   - `interrupted = true`
   - `backend.reason = "interrupted"`
   - `phase = "failed"`
3. 新 session 只在以下情况创建：
   - 新的 `orchestrationId` 出现
   - 或命中 `turnId / ephemeral` 兜底策略

### 5.6 Phase 合法迁移

主路径：

```text
collecting -> ready -> playing -> settling -> completed
```

允许的失败路径：

```text
collecting -> failed
ready -> failed
playing -> failed
settling -> failed
```

补充约束：

- `completed`、`failed` 为终态
- 不允许从终态回退到中间态
- `interrupt` 默认进入 `failed`
- `markPhase()` 必须拒绝非法回退

## 6. 新增模块

### 6.1 `session.ts`

职责：

- 定义 `TurnPlaybackSession`
- 定义 phase 和子状态枚举
- 提供基础构造函数和纯工具函数

建议导出：

- `createTurnPlaybackSession(orchestrationId, turnId?)`
- `isSessionReadyForRelease(session)`
- `isSessionPlaybackComplete(session)`

### 6.2 `useTurnPlaybackSessionStore.ts`

建议新增：

```text
frontend/src/composables/useTurnPlaybackSessionStore.ts
```

职责：

- 持有 `sessions: Map<string, TurnPlaybackSession>`
- 持有 `activeSessionId`
- 负责统一更新 session

建议提供：

- `ensureSession(orchestrationId, turnId?)`
- `getSession(orchestrationId)`
- `setActiveSession(orchestrationId)`
- `markTextReceived(text, mode?)`
- `markTextReleased(...)`
- `markTextDelivered(...)`
- `markAudioReceived(...)`
- `markAudioStarted(...)`
- `markAudioTerminal(...)`
- `markMotionReceived(...)`
- `markMotionStarted(...)`
- `markMotionCompleted(...)`
- `markTurnStarted(...)`
- `markTurnFinished(...)`
- `markPhase(...)`
- `finalizeSession(...)`
- `pruneSessions(...)`

store 设计约束：

- 更新函数必须幂等
- 同一个事件重复写入不能破坏 session
- 相邻事件顺序不同，只要协议语义等价，最终 session 状态应一致

### 6.3 `turnPlaybackSessionSelectors.ts`

建议新增一组纯函数：

```text
frontend/src/turn-playback/selectors.ts
```

职责：

- 从 session 读取编排层关心的判断
- 避免在多个 composable 里手写相同判断

建议包含：

- `canReleaseText(session)`
- `canReleaseAudio(session)`
- `canReleaseMotion(session)`
- `shouldWaitForLateMotion(session, nowMs)`
- `isReadyToAckPlaybackFinished(session)`

## 7. 迁移阶段

## 阶段 1：定义 Session 模型与 Store

### 目标

先建立新概念，不动现有主链路行为。

### 改动

新增：

- `frontend/src/turn-playback/session.ts`
- `frontend/src/turn-playback/selectors.ts`
- `frontend/src/composables/useTurnPlaybackSessionStore.ts`

同时更新：

- `frontend/src/composables/usePetDesktopController.ts`

阶段 1 中 `usePetDesktopController.ts` 的职责仅为：

- 初始化并注入 `sessionStore`
- 不改变现有起播 / 完成逻辑

### 输出

- 有明确的类型
- 有统一的 store
- 有可以独立测试的纯逻辑函数

### 验收

- `typecheck` 通过
- store 的纯单测通过

## 阶段 2：Adapter 双写到 Session

### 目标

不切旧逻辑，先让 session 真正长起来。

### 主要改动文件

- [frontend/src/composables/useAdapterConnection.ts](/c:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/composables/useAdapterConnection.ts)
- [frontend/src/composables/usePetDesktopController.ts](/c:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/composables/usePetDesktopController.ts)

### 处理方式

对以下协议事件做“双写”：

- `control.turn_started`
- `output.text`
- `output.audio`
- `engine.motion_intent`
- `engine.motion_plan`
- `control.synth_finished`
- 音频 started / ended / error
- `control.turn_finished`
- `control.interrupt`

双写含义：

- 旧字段继续保留
- 同时调用 session store 更新对应状态

这里必须明确三条规则：

1. `control.interrupt`
   - 不创建新 session
   - 只标记当前 active session 为 interrupted / failed
2. `output.text`
   - 第一版默认按 `replace` 模式写入 `session.text.content`
3. `session.id`
   - 严格遵循 5.1 节的 `orch -> turn -> ephemeral` 优先级

### 重点

这里先不删：

- `pendingAssistantText*`
- `pendingAudio*`
- `turnFinished*`
- `audioPlaybackTerminal*`

它们先作为兼容桥保留。

### 验收

- 收到一轮文本 / 音频 / 动作后，session 中能完整看到轮次状态推进
- 现有起播和完成逻辑行为不变

## 阶段 3：起播编排器切到 Session

### 目标

让 `useTurnPlaybackOrchestrator` 不再直接依赖 adapter 的散装 pending 字段。

### 主要改动文件

- [frontend/src/composables/useTurnPlaybackOrchestrator.ts](/c:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/composables/useTurnPlaybackOrchestrator.ts)
- [frontend/src/composables/turnPlaybackOrchestratorCore.ts](/c:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/composables/turnPlaybackOrchestratorCore.ts)
- [frontend/src/composables/usePetDesktopController.ts](/c:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/composables/usePetDesktopController.ts)

### 调整方向

从现在的：

- `pendingAssistantTextNonce`
- `pendingAudioNonce`
- `inboundMotionPlanNonce`
- `audioPlaybackTerminalNonce`
- `turnFinishedNonce`

改成：

- 观察 active session 的 `text/audio/motion/backend`
- core 输出 release 决策后，回写 session：
  - `text.released = true`
  - `motion.started = true`
  - `phase = "playing"` 或 `"ready"`

### 关键要求

- orchestrator 只负责开始，不负责结束
- orchestrator 不再自己隐式代表“当前轮次”
- release reason 写回 session，便于调试

### 验收

- 文本-only
- 文本+音频
- 文本+音频+动作
- 动作晚到
- 无音频

以上场景都能只通过 session 状态解释起播结果。

## 阶段 4：完成协调器切到 Session

### 目标

让 `usePlaybackCompletionCoordinator` 不再维护一套平行的 `playbackCoordination` 事实来源。

### 主要改动文件

- [frontend/src/composables/usePlaybackCompletionCoordinator.ts](/c:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/composables/usePlaybackCompletionCoordinator.ts)
- [frontend/src/composables/usePetDesktopController.ts](/c:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/composables/usePetDesktopController.ts)

### 调整方向

现有 `playbackCoordination` 可以保留为内部派生缓存，但不再作为系统真源。

完成判定统一改成基于 session：

- `text.delivered === true`
- `audio.terminal in {"completed", "failed", "absent"}`
- `motion.completed === true` 或 `motion` 明确不参与
- `backend.turnFinished === true`

### 关键要求

- `backend.turnFinished` 只表示后端这一轮收口
- `session.phase = "completed"` 才表示前端播放真正完成
- `sendPlaybackFinished(...)` 应由 session 驱动，而不是由 scattered watchers 拼出来

### 验收

- 完成条件在代码中可被一句话描述
- 不再需要同时追多组 nonce 才能理解完成语义

## 阶段 5：ModelEngine 并入 Session 语义

### 目标

让 `useModelEngine` 不再长期维护平行的轮次待播系统。

### 主要改动文件

- [frontend/src/model-engine/useModelEngine.ts](/c:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/model-engine/useModelEngine.ts)
- [frontend/src/model-engine/contracts.ts](/c:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/model-engine/contracts.ts)
- [frontend/src/composables/usePetDesktopController.ts](/c:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/composables/usePetDesktopController.ts)

### 当前问题

现在 `pendingInboundMotionPayloads` 是一套独立的 turn 队列。

它与：

- adapter 当前轮次
- orchestrator group
- completion coordination

平行存在。

### 调整方向

改为：

- session store 保存 `motion.payload`
- orchestrator 决定何时把 payload 交给 engine
- engine 只负责编译和执行
- engine 的等待音频兜底逻辑如果还保留，也应依赖 session，而不是自带另一张 turn map

这里额外明确：

- 第一版不强行把 `MOTION_SYNC_WAIT_FOR_AUDIO_MS` 整体挪到 orchestrator
- orchestrator 的职责仍然是“决定何时 release”
- engine fallback 的职责仍然是“payload 已进入 engine 后，等待音频多久再启动”
- 但它读取的事实来源应改成 session，而不再是 engine 自己的平行 turn 语义

### 验收

- 代码里不再存在另一套“当前待播轮次”的长期事实来源

## 阶段 6：删除旧字段和兼容层

### 目标

删除已经被 session 吸收的旧状态。

### 优先删除对象

- `pendingAssistantText*`
- `pendingAudio*`
- `assistantTextDelivery*`
- `turnFinished*`
- 一部分 `audioPlaybackTerminal*`
- `clearPlaybackGroupContext()` 这类依赖散装轮次字段的收尾逻辑

### 注意

这一步必须在阶段 3、4、5 全部稳定后再做。

### 验收

- 代码中只保留一套播放轮次事实来源
- 模块职责明显收缩

## 阶段 7：更新 Snapshot / 调试 / 文档

### 目标

把 session 作为前端运行时的新显式对象暴露出去。

### 主要改动文件

- [frontend/src/composables/usePetRuntimeSnapshotPublisher.ts](/c:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/composables/usePetRuntimeSnapshotPublisher.ts)
- [frontend/src/types/desktop.ts](/c:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/types/desktop.ts)
- [frontend/src/composables/usePetDesktopController.ts](/c:/Users/Administrator/Documents/GitHub/AG99live/frontend/src/composables/usePetDesktopController.ts)
- 当前链路说明文档

### 调整方向

新增 session 相关调试投影：

- active session id
- session phase
- text/audio/motion/backend 状态
- release reason
- completion reason

### 验收

- Action Lab / Settings / 调试面板能看到当前播放轮次推进过程

## 8. 文件级实施清单

### 新增文件

- `frontend/src/turn-playback/session.ts`
- `frontend/src/turn-playback/selectors.ts`
- `frontend/src/composables/useTurnPlaybackSessionStore.ts`
- `frontend/tests/turnPlaybackSessionStore.test.ts`

### 第一批改造文件

- `frontend/src/composables/useAdapterConnection.ts`
- `frontend/src/composables/useTurnPlaybackOrchestrator.ts`
- `frontend/src/composables/turnPlaybackOrchestratorCore.ts`
- `frontend/src/composables/usePlaybackCompletionCoordinator.ts`
- `frontend/src/model-engine/useModelEngine.ts`
- `frontend/src/composables/usePetDesktopController.ts`
- `frontend/src/composables/usePetRuntimeSnapshotPublisher.ts`
- `frontend/src/types/desktop.ts`

## 9. 测试计划

## 9.1 纯逻辑测试

新增或扩展：

- `turnPlaybackSessionStore`
- `turnPlaybackOrchestratorCore`
- `playbackCompletionCoordinator`
- `modelEngine` 与 session 的交互

必须覆盖：

1. 文本-only
2. 文本+音频
3. 文本+动作，无音频
4. 文本+音频+动作
5. 动作晚到
6. 音频失败
7. 后端先 `turn_finished`，动作后完成
8. 缺失 `turnId`，但有 `orchestrationId`
9. 缺失 `orchestrationId` 的兜底策略
10. 中断和新一轮覆盖旧一轮
11. `replace` 模式下多次 `output.text` 覆盖行为
12. 相邻事件顺序不同但最终状态一致
13. 非法 phase 回退被拒绝

## 9.2 手工联调

必须验证：

1. 真实一轮回复时，文本 / 音频 / 动作状态能在 session 中连续推进
2. 历史动作记录仍可写入 Action Lab
3. `playback_finished` 仍能正确回传后端
4. 辅助窗口刷新后，不依赖旧的散装状态也能正常展示 runtime 投影

## 10. 风险与注意事项

### 10.1 语义迁移风险

风险最大的不在“代码改错”，而在“旧字段和 session 同时存在时，谁算真源”。

因此必须坚持：

- 阶段 2 双写期间，明确 session 为新真源候选
- 阶段 3 开始，新的读路径优先读 session

### 10.2 枚举清理风险

当前 `not_requested` 语义混杂。

迁移时必须显式拆成：

- `absent`
- `idle`
- `completed`
- `failed`

不能继续沿用旧含义。

### 10.3 调试可见性风险

如果 session 引入后没有调试投影，问题会比现在更难排查。

所以调试字段必须跟着阶段 3 和阶段 4 同步补。

## 11. 验收标准

本计划完成后，以下描述必须成立：

1. 前端存在明确的 `TurnPlaybackSession`
2. 同一轮的文本、音频、动作和后端收口状态都归属于同一个对象
3. 起播编排只消费 session
4. 完成判定只消费 session
5. `ModelEngine` 不再长期持有平行轮次系统
6. 代码阅读时，开发者可以通过 session 一眼看出“这一轮当前处于哪一步”

## 12. 建议执行顺序

建议按以下顺序推进：

1. 阶段 1：定义模型与 store
2. 阶段 2：adapter 双写
3. 阶段 3：切起播编排
4. 阶段 4：切完成协调
5. 阶段 5：合并 ModelEngine 轮次语义
6. 阶段 6：删旧字段
7. 阶段 7：补 snapshot / 调试 / 文档

不建议跳步，不建议先删旧字段。

## 13. 与现有文档的关系

本计划是对以下文档的补充收口：

- [文本语音动作同步播放编排设计](./文本语音动作同步播放编排设计.md)
- [当前前后端动作链路结构说明](./当前前后端动作链路结构说明.md)
- [V2当前实现状态与下一步](./V2当前实现状态与下一步.md)

它不替代这些文档，而是专门回答：

**前端怎样把“播放轮次”从散装状态收口成统一 Session。**
