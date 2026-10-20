# AG99live · 补丁堆积专项审计（2026-10-18）

聚焦用户指定的形态:**新功能通过"加新代码"实现,旧代码未被删除或修改,最终以补丁形式堆叠**。

审计范围:全仓 979 commits / 659 文件(排除 vendored `WebSDK/`、`live2ds/`、生成物)。
基线:`786bf9c`。**注意工作区有未提交改动**:`playbackTimelineRuntime.ts`(+11/-5)、`useTurnPlaybackOrchestrator.ts`(+50/-22)、`.ai/state.yaml`(+19)——见文末"你正在改的地方"。

---

## 一、这次找到的东西(按严重度)

### P0-1 · 同一函数定义了两次,旧版胜出,且是**正在生效的 bug** 🔴

**证据**(AST 静态 + 运行时实证):

`astrbot_plugin_ag99live_adapter/middleware/interaction_motion/independent.py` 中 `_consume_background_motion_exception` 定义了两次:

| 位置 | 内容 | 提交 |
|---|---|---|
| `:150-161` | 有 `try/except asyncio.CancelledError` 保护(`:155-156`) | `3b84c34`(10-16) |
| `:198-206` | **无保护**,`error = task.exception()` 裸调用 | `4a013ec`(10-08) |

Python 模块级命名空间后定义者胜出。运行时实测:

```
found defs at lines: [150, 198]
module-level binding resolves to line: 198
bound version (line 198) has try/except CancelledError: False
  line 150: try/except = True
  line 198: try/except = False
protected(line150):   returned normally (swallowed)
unprotected(line198): RAISED CancelledError out of callback
```

**为什么有害**:这两个 callback(`:186`、`:194`)注册的位置,恰恰是 `await_with_hard_deadline` 在 **task 已被 cancel** 时兜底用的。当 cancel 与 callback 执行存在竞态时,`:198` 版本会让 `CancelledError` 从 done_callback 里抛出来——即 `3b84c34` 想加的取消保护**完全没生效**,而且新增的加固代码本身成了误导。

**收敛方向**:删 `:198-206`,保留 `:150`。这个只需删 9 行,无行为设计变更。**建议优先做**——它是本次唯一"删掉就能立刻修 bug"的问题。

**Confidence**: confirmed(AST + 运行时双证)

---

### P0-2 · 播放裁决在 runtime 旁边长出第二套,编排器还直写 store 🔴

`playbackTimelineRuntime.ts` 已持有 timeline 生命周期与 blocker 查询(`findPlaybackReleaseBlockers`、`hasOpenSink`),但 `useTurnPlaybackOrchestrator.ts` 不信任它,自己再实现一遍:

| 编排器重复的决策 | 位置 |
|---|---|
| `isAtomicSegmentResolved` 自己判断"段能否释放" | `:135,297-307` |
| 调 `findPlaybackReleaseBlockers()` 后**再写一个例外过滤器**绕过 | `:95-106` + 过滤器 `:96-102` |
| `releaseText/releaseAudio/releaseMotion` 三元组,读 selectors 私有判据 | `:186-189` |
| `motion_received_at_missing` 拒绝策略 | `:204-218` |
| **直接 `markMotionFailed(...)` 写 store**,绕过 runtime 的 `segmentExecution.session` 端口 | `:43` |
| **直接 `markPhase(turnId,"ready")`**,而 runtime 自己也在 `markPhase` | `:163-165` |

**决定性证据**:runtime 暴露了 `findPlaybackReleaseBlockers`,却**没暴露"跳过自己的 blocker"的能力**,于是编排器只能手写过滤器绕过它。这是**契约缺失导致的下层复制**,不是编排职责。

**收敛方向**:blocker 判据下沉为 runtime 的 `isBlockerForSegment`;`isAtomicSegmentResolved` 合并进 `startSegmentJob` 前置条件;`:43`/`:163` 的 store 直写改走 runtime 端口。

**Confidence**: confirmed

---

### P1-3 · 增量动作状态双来源,旧 key 只有测试在写 🔴

`f8098e7`(10-18)引入按 `persona_result_id` 分桶的 `_interaction_incremental_motion_states`,但旧的扁平 key 全部保留,**读时回落、写时镜像**:

- 新路径:`platform_event.py:220-225`、`:242-259`
- 旧回落三处:`:228`、`:351`、`:385` 均为 `if writer is None: writer = self.get_extra("_interaction_incremental_output_writer")`
- 旧 key 双向桥接:`:246-247` 用旧 key 初始化新 state;`:259`、`:377` 又把新 state 的 `pending` 写回旧 key

**关键**:`_interaction_incremental_output_writer` 在**整个生产代码里没有任何 `set_extra`**,唯一写入点是 `tests/unit/runtime/test_platform_event_prompt_annotations.py:332` 的 `WriterStub()`。

即:**生产不可达,仅被测试激活**。而这条测试把旧 key 写进了契约——直接删会先红。

**收敛方向**:先改测试改用 `_interaction_incremental_motion_states`,再删 `:228/:351/:385` 三处回落与 `:259/:377` 镜像写。

**Confidence**: confirmed

---

### P1-4 · 动作生成三套并存,靠三个布尔开关二选一 🔴

`_conf_schema.json` 的 `independent_motion.enabled` / `.parallel` / `.per_speech_segment` + `state.py:115-116` ——这些**不是"关一个功能",而是在三条实现间二选一**:

| 路径 | 实现 | 入口 |
|---|---|---|
| A Persona Effect(主模型产出) | `effects.py:28-89` | `state.py:254-257` 在独立模式为真时把 `persona_effect_enabled` 置 False |
| B 整条回复(串/并行) | `independent.py:969-1009` | `main.py:228-237` |
| C 逐 speech 段 | `independent.py:542` | `main.py:1303-1335` |

**互斥逻辑散在四处**:`main.py:214-226`、`:297-309`、`platform_event.py:87-107`、`scheduling.py:1320`。

**已自认的痕迹**:`independent.py:720-725` 注释——"Keep the legacy batch call compatible with providers and test doubles that implement the older API";`scheduling.py:788-796`——"The legacy full-result binding below requires a known final count"。

**可达性**:B 与 C 都可达(B 在"整条回复模式"下走 `persona_result_id is None and not stream_active` 的 legacy batch 形态);legacy 全量绑定是**默认路径**(流式开关默认关,`preferences.ts:80-91`)。

**收敛方向**:确定唯一保留的分段路径后,删除 B 的 legacy batch 形态与 `__init__.py:38-41` 的 `_include_legacy_motion_result_contributor` 过滤器。

**Confidence**: confirmed(并存)/ needs confirmation(哪条是目标形态)

---

### P1-5 · `getattr(self, 必存在字段, None)` 防御残留 🔴

这是"字段后加、调用方没同步"的指纹。6 处:

| 位置 | 探测字段 | 实际状态 |
|---|---|---|
| `turn_coordinator.py:611`、`:855` | `self.turn_identity_map` | `:119` 在 `__init__` **无条件赋值** |
| `turn_coordinator.py:884`、`:925` | `self.runtime_state` | `:120` 在 `__init__` **无条件赋值** |
| `platform_event.py:492`、`:624` | `self._record_send_operation` | **全仓生产代码里根本没有这个方法** |

最后一条最典型:**生产代码用 `getattr(self, "_record_send_operation", None)` 探测一个只在测试桩里存在的方法**(`test_platform_event_prompt_annotations.py:37`)。

**收敛方向**:前四处直接 `self.field`;`platform_event` 两处需要先确认这个钩子是否已废弃——若是,连同对应测试一起删。

**Confidence**: confirmed

---

### P1-6 · WS 入队无限自旋,把背压变成挂起 🔴

`transport/websocket_server.py:222-231` `_enqueue_payload` 用 `while True` + `wait_for(timeout=0.25)` 重试,入队超时后 `continue` **无限重试**,直到连接变更才返回 False。

队列满本是**背压信号**,应当失败上报;现在变成自旋等待。对比同文件 `:251-255` 单次发送失败即终止 writer(契约清晰)——同文件内两种错误观不一致。

**对照健康样板**:`live2d/scanner/scan.py:230-239` —— 选中模型 raise(`:231`)、非选中 warn+skip(`:234`)。**这是全仓最健康的失败处理二分,建议作为其他模块的参照模板。**

**Confidence**: confirmed

---

### P1-7 · `platform_event` 反向 import middleware,双向持有调度 🔴

`platform_event.py:876-879` 在函数体内**反向 import** `middleware.interaction_motion.independent`,而 `scheduling.py:231-248` 已在做 `_MotionScheduleAttempt` / `pending_performance_curve` 编排。

即 **middleware 与 platform event 双向持有调度逻辑**,middleware 无法被单独替换或测试。1518 行的 `platform_event` 同时持有 prompt 标注(`:1436`)、TTS 失败解析(`:1094`)、段 ID 分配(`:984`)三块非平台职责。

**收敛方向**:把 `_attach_persona_stream_motion` 及其 import 收回 middleware,让 `platform_event` 只做 emit。

**Confidence**: confirmed

---

### P2 · 纯透传与死抽象(可直接删,零风险)

| 目标 | 证据 | 判定 |
|---|---|---|
| `snapshot.ts` 19 行 re-export 桶 | 零逻辑,只 re-export 4 个 snapshot 模块 | 直接删,调用方改 import 具体路径 |
| `projection.buildAdapterRuntimeProjection` | `:128-157` 是 1:1 字段改名(`input.address`→`adapterAddress`),无聚合无默认值 | 内联掉 |
| `turn-playback/ports.ts` 15 行 | 仅 2 个 interface,`PlaybackAckPort` **零实现零行为** | 删 |
| `useDesktopWindowActions.ts` 15 行 | 纯透传,唯一消费者 `DesktopWindowPanel.vue` | 删 |
| `useAdapterConnection.sendText` | `:942-944` 仅 `return sendTextAction(outboundCtx, text)` | 调用方直连 `outboundActions` |
| `InboundDispatchDeps.buildInboundEventContext` | 4 个消费者全不读,每条消息仍真构造(`adapterInboundRuntime.ts:97,160`) | 删参数 + 构造 |

**Confidence**: confirmed(均已逐个确认无实现方与无读取方)

---

### P2 · 同一快照在进程内被构造并规范化两次

链路 `projection → snapshot → useDesktopBridge → publisher`:
- 状态变化 → deep watch(`:265-269`)→ 60ms debounce → build → **normalize(`:475`)** → BroadcastChannel → 接收端**再 normalize 一次(`:299`)**
- 叠加 `useAdapterConnection.ts:369-372` `esp32ConfigQueue`、`:632` `lifecyclePromise` 两个串行队列,以及 `desktopSettings.ts:612` `esp32RequestQueue`
- `projection.ts:167-170` 为取最后一条 user 文本,`slice().reverse().find()` 复制整个历史数组

**注**:`esp32ConfigQueue`/`lifecyclePromise` 本身是**合理的真实竞态防御**(注释 `:328-330` 说明 web-control 并发请求会导致旧快照重启连接),`desktopSettings.ts` 的聚合 handler 也是防漂移机制——**别删**。

---

### P2 · Core 兼容分支 + 一个专门钉住旧 API 的测试

`core_compatibility.py:110-131` 三个能力探测函数(`supports_interaction_result_event_filter` / `supports_llm_response_hook` / `supports_persona_segment_stream_hooks`),`main.py:148` 合成 `_official_core_compatibility`,在 `main.py:163/201/319/449/504/800/1249` **共 7 处早退**。

`interaction_motion/__init__.py:29-35` 在支持 `event_filter` 与不支持时注册**两种形态**的同一个 contributor。

**但测试固化成了包袱**:`test_middleware_registration.py:375-409` `test_interaction_registration_keeps_legacy_core_contributor_api` 用只实现旧签名的 `LegacyContext`,断言仍返回 `True`——把"旧 Core 仍可注册"变成了仓库契约。

**判定**:兼容层本身**有意**(AstrBot 版本确实会漂移),应保留;**该测试应改为验证"能力探测返回 False 时走哪条分支"**,而不是验证旧 API 仍被支持。

---

## 二、确认**健康**的部分(别误伤)

这轮排查刻意验证了以下"疑似重复",结论都是**分层而非重复**:

1. **音频链**:`audioSink` → `audioSegmentPlaybackSink` → `audioSegmentTimelineRunner` → `audioPlaybackControl`,每层职责明确,不是重复。
2. **两条输出后端**:`pcmOutputSession.ts` / `pcmTimelinePlayback.ts`(PCM/WebAudio)vs `audioSink.ts`(URL/HTMLAudio)——共用音量源,是两条后端而非两套实现。
3. **麦克风**:`microphoneCapture.ts` 用 `kind: "web"|"native"` 判别联合统一,原生优先、失败回落 Web AudioWorklet。Web 构建无 Electron,回退是必需的。
4. **窗口管理**:`window-manager.ts`(建 BrowserWindow)vs `web-control-launcher.ts`(URL 持久化 + 外链)职责正交。
5. **历史记录**:WS 路径与 HTTP 路径是**双表面**设计,后端**唯一**(`services/history_service.py:18 ConversationHistoryBridge`,在 `web_control.py:994-996` 汇入同一 bridge),归一化函数也**唯一**(`features/historyPayload.ts` 两处共用)。
6. **协议解析三分**:`protocol.cpp` / `inboundEvents.ts` / `parser.py` 分属三个进程,不是并行实现。前端 `inboundEvents.ts:191` 统一走 `INBOUND_MESSAGE_TYPES` 常量,**无裸字面量**。
7. **URL 改写**:`features/modelSyncRewrite.ts` 全仓唯一,无第二套。
8. **类型声明**:`types/desktop.ts`(37 个 `Desktop*`)与 `types/protocol.ts`(74 个协议类型)**导出名交集为空**,snapshot 只 import 不重声明。"OLV/PCM 字段多处各声明一份"的假设**不成立**。
9. **麦克风/音频/窗口/Bilibili/ESP32 的失败降级**多为有界、有日志的边界防御。
10. **已收敛的正确案例**:`middleware/interaction_motion.py`(94 commits)已由 `d60725b` 拆分为目录并删除原文件;`frontend/src/composables/useAdapterConnection.ts`(56 commits)已由 `a8a2b2e` 删除。**你确实做过"删除式重构",这是好信号。**

---

## 三、命名层面的歧义(非紧急,但会误导阅读)

| 词 | 问题 |
|---|---|
| `session` | **一词三义**:`TurnPlaybackSessionStore`(一个 turn 的播放会话)、`SpeechOutputSession`/`PcmOutputSession`(音频会话)、WebSocket 会话 |
| `profile` | **一词二义且方向相反**:`SemanticAxisProfile`(语义轴档案,19 处)vs `VoiceFollowingProfile`(音色档案,9 处) |
| `voice` | **命名孤儿**:`VoiceFollowingProfile` 与 `audio/speech/tts/pcm` 无语义关系 |
| `spec` | 全仓仅数处,`DESKTOP_SETTINGS_SPEC` 用它指"字段清单"而非规格文档,语义偏离 |
| `runner` vs `executor` | `audioSegmentTimelineRunner` vs `segmentJobExecutor` 语义相邻,**needs confirmation** |

另有一条 P2:`DesktopMotionTuningSample` 在 `types/desktop.ts:262`(camelCase)与 `types/protocol.ts:587`(snake_case)重复声明同一 wire 实体,手工双向映射在 `features/motionTuningPayload.ts:12-38`。**可选性已不一致**:`profile_id?: string` → `profile_id: sample.profileId ?? ""`(protocol 侧必填)。

---

## 四、需要你拍板的问题

**1. 动作生成到底保留哪条路径?**(P1-4)

Persona Effect / 整条回复 / 逐 speech 段 三条并存,靠 3 个开关二选一,互斥逻辑散在 4 处。其中 legacy 全量绑定还是**默认路径**。这个问题不解决,P1-4 无法收敛——而它下面压着 `scheduling.py:834-842`、`__init__.py:38-41`、以及 7 处 `_official_core_compatibility` 早退。

**2. 流式是目标形态还是实验?**(P1-4 关联)

`independent.py:720-725` 与 `scheduling.py:788-796` 的注释表明新路径尚未夺权。若流式是目标,legacy 批量形态与 legacy 全量绑定可以整块删;若流式还在实验,那这些兼容分支是合理的,但应该显式标注实验边界而不是靠隐式回落。

**3. C++ 原生运行时是长期并存还是终将替换?**(上轮 P0-2)

`render-core/README.md:110` 写明 "TS desktop remains the stable reference implementation",但 C++ 侧 `CompileMotionPlan` 仍在独立演进。**需要确认它是"终将替换 TS"还是"长期双运行时"**——这决定那 14 个 struct 该留还是该拆。

---

## 五、建议执行顺序

**立刻做(低风险、高回报)**
1. 删 `independent.py:198-206`(9 行)—— 修一个正在生效的 bug
2. `turn_coordinator.py:611/855/884/925` 的 `getattr(self, ..., None)` 改直取 —— 4 处
3. 删 `snapshot.ts`、`turn-playback/ports.ts`、`useDesktopWindowActions.ts` —— 纯死代码

**同一批里做(需先改测试)**
4. P1-3:先改 `test_platform_event_prompt_annotations.py:332` 用新 state,再删 `platform_event.py:228/351/385` 回落与 `:259/377` 镜像

**需要设计决策**
5. P0-2 播放裁决收敛(契约缺失是根因,建议先给 runtime 加 `isBlockerForSegment`)
6. P1-6 WS 入队改为失败上报(参考 `scan.py:230-239` 的健康样板)
7. P1-7 调度逻辑归位 middleware

---

## 你正在改的地方

工作区未提交改动正好落在 **P0-2** 上,而且方向是对的:

```diff
-    const blockers = options.timelineRuntime.findPlaybackReleaseBlockers();
-    if (blockers.length > 0) { ...; return; }
+    const blockers = options.timelineRuntime.findPlaybackReleaseBlockers().filter((blocker) => !(
+      segment?.incremental && segment.audio.terminal === "completed" && segment.motion.payload
+      && !segment.motion.released && blocker.turnId === segment.turnId && blocker.messageId === segment.messageId
+    ));
```

把 blocker 过滤从"全局早退"改成"按段精确排除",并收紧了 rejected-motion 条件(新增 `segment.motion.absent` 排除、移除 `audio.terminal === "completed"` 的早退分支)。这消除了我列的 P0-2 里"编排器自写例外过滤器"的大半。

**不过根因仍在**:`findPlaybackReleaseBlockers` 依然没有"本段不算 blocker"的能力,过滤器还是写在编排器里。理想形态是把这条规则下沉成 runtime 的一个方法,让 runtime 知道自己产生的 blocker 何时对自己的段无效。后续收敛不必推翻你现在的改法,只是把这段逻辑搬进 runtime。

---

## 更正一条上轮结论

`docs/codebase-audit-round2.md` 中称"TS 侧 `model-engine/normalize.ts` 用**类型断言** `as 1|2|3`,C++ 用**真校验**,两侧行为必然不同"——**此结论已失效**。

`normalize.ts:63-69` 现在是完整的运行时校验(`isFiniteNumber` / `Number.isInteger` / `<1` / `>3`),`:74` 的 `as 1 | 2 | 3` 只是通过校验后的收窄断言,与 C++ `main.cpp:4460` 语义等价。**两侧的 `duration_weight` 校验目前是一致的,不必再作为分歧点。**

---

## 审计方法与边界

**取证手段**:grep / glob / read 静态分析 + `git log --follow` / `git blame` / `git diff` 考古 + **AST 解析与运行时实证**(P0-1 通过 `ast.parse` 确认双定义与绑定结果,并写临时脚本复现两种实现的异常行为差异,验证后已删除该脚本)。

**未执行**:未运行 `pytest` / `npm test` / `typecheck` / CMake 构建。P0-1 的"bug 正在生效"是通过 AST 绑定解析 + 模拟竞态复现证明的,**不是**通过真实取消时序的生产环境复现——真实触发概率未验证。

**未覆盖**:`vts-data-recorder/`、`tools/`、`frontend/native/spout/`、`electron/main/index.ts` 的完整菜单逻辑。

**工作区状态**:审计开始时已有 3 个文件的未提交改动(你自己的),全程未修改任何项目文件;仅创建并已删除一个临时验证脚本。
