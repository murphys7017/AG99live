# AG99live 架构审计 · 第二轮(2026-10-18 复核)

> **历史快照**：本文保留 2026-10-18 的审计证据。协议和实现已继续演进，当前结论以 [文档中心](README.md) 和源码为准。

对照第一轮审计(2026-10-01,commit `979224a` → 现 HEAD `786bf9c`,**183 个提交**)逐条复核。

**最重要的一句话:第一轮的 P0-1 从"预测"变成了"已发生的事实"。**

---

## 复核结论速览

| 上轮问题 | 当前状态 |
|---|---|
| P0-1 协议版本权威失效 | 🔴 **已发生故障** —— manifest 已升 `output.segment.v6`,C++ 仍硬编码 v5 |
| P0-2 双动作编译器 | 🔴 **恶化** —— C++ 端内联编译从 285 行涨到更大,main.cpp 2201→5618 行 |
| P1-3 终态词表三份 | 🔴 **未变** |
| P1-4 段五重标识 | 🔴 **未变** |
| P1-5 后端 turn 终态双状态 | 🟡 **未变**(原描述有误,已更正) |
| P1-6 媒体失败致 turn 二次失败 | 未单独复核 |
| P1-7 WS 无鉴权 + CORS `*` | 🔴 **未变**,且被新面板放大了风险性质 |
| P1-8 视图内嵌业务逻辑 | 🔴 **未变** |
| P2-9 快照三重深拷贝 | 🟡 有 perf 提交(`51b11d4`),未逐条确认 |
| P2-10 inbound 5 跳 + 死依赖 | 🔴 **未变** |
| P2-11 ESP32 静默 | 🟡 **部分修复** |
| P2-12 失败静默 | 未单独复核 |
| P2-13 协议校验真空 | 🔴 **恶化**(v6 断层 + 新游离 schema) |
| P3-14 文档漂移 | 🔴 **未变** |
| P3-15 构建产物 | 🔴 **恶化** —— 新增 178KB 编译产物入库 |

---

## P0-1 · 协议断层已实际发生 🔴

**这是本轮最重要的发现。**

17 天前报告的原话是:「改 `schema_manifest.json` 的版本号时,`check_protocol_schema_manifest.py` 会通过……但 C++ 运行时会在 `protocol.hpp:360` 抛 `ProtocolError`——一个只有真实桌面运行才能发现的错误。」

**它发生了。**

- `astrbot_plugin_ag99live_adapter/protocol/schema_manifest.json` 现为 `output.segment.v6`,并新增 3 个 OLV schema(`olv.pre_action.v1`、`olv.audio_input.v1`、`olv.audio_credit.v1`),schema 总数 11 → **14**。
- `frontend/src/types/protocolSchema.generated.ts:9` 已是 `SCHEMA_OUTPUT_SEGMENT_V6 = "output.segment.v6"` —— TS 侧跟进了。
- `runtime-core/include/ag99/runtime/protocol.hpp:19` **仍是** `kOutputSegmentSchema = "output.segment.v5"`。
- `runtime-core/src/protocol.cpp:400-401`:
  ```cpp
  if (schema_version != kOutputSegmentSchema) {
    throw ProtocolError("payload.schema_version must be output.segment.v5");
  }
  ```
  → **C++ 运行时现在会拒绝 Adapter 发出的每一个段。**
- `scripts/check_protocol_schema_manifest.py` 实测 **`EXIT=0`(完全通过)**,因为它只比对 manifest ↔ TS,`grep 'runtime-core|render-core|hpp|cpp'` 命中数为 **0**。

**为什么没被立刻发现**:`render-core` 不在任何构建或 CI 脚本中(`grep` 所有 `.cmd`/`.ps1`/`.json`/`.yml` 只命中 `.ai/state.yaml` 的人工构建记录)。`render-core/README.md:110` 自己写明:「The TS desktop remains the stable reference implementation for new features and testing」。

**部分改善**:`protocol.hpp` 现在集中了版本常量,并补上了 `kParameterPlanSchema`(`:21`),比上次散落各处好。但仍未从 manifest 派生。

**Recommended Direction**:让 C++ 常量由 manifest 生成,并把该约束写进 `check_protocol_schema_manifest.py`。方向是"派生",不是"两处手工同步"。

---

## P0-2 · 双动作编译器,且在恶化 🔴

| | 第一轮 | 现在 |
|---|---|---|
| `render-core/src/main.cpp` | 2,201 行 | **5,618 行** |
| 结构 | 7 个 class | 29 个 class/struct |
| 已提取模块 | 无 | 20 头文件 + 16 源文件 |

**进展是真实的**:平台层已被正确切出(`input_overlay_*`、`tray_controller`、`audio_wav`、`d3d11_renderer`、`speech_signal` 等)。

**但业务层完全没动**:新增的 14 个参数/动作 struct 全部仍在 `main.cpp` 内 —— `MotionPlan:2644`、`ParameterPlan:2716`、`ParameterFrameGroup:2756`、`AxisDefinition:4221`、`DynamicsState:3216`。动作编译器仍是 `main.cpp:4190` 的 `CompileMotionPlan`,`main.cpp:4460` 仍在校验 `duration_weight < 1 || > 3`。

对照 TS 侧:`model-engine/` 仍是同一职责的独立实现,且 `model-engine/normalize.ts` 用**类型断言** `as 1 | 2 | 3`,C++ 用**真校验**。同一非法输入,两侧行为必然不同,且不会报错。

**结论**:平台层抽象做对了,**领域层没有跟上**。`CompileMotionPlan` 和它依赖的 14 个 struct 应属于 `motion/` 域模块,而不是 `main.cpp`。

---

## P1-7 · WS 无鉴权 —— 未变,但风险性质变了 🔴

代码未变(`transport/websocket_server.py:88-93` 仍无 `process_request`/token;`static_resources.py:41-45` 仍无条件 `Access-Control-Allow-Origin: *`)。

**但新增的 web 面板改变了风险面貌**。需要更正第一轮的一个判断:

新增的 `astrbot_plugin_ag99live_adapter/web_control.py:1259` 有 `_require_dashboard_user()`,16 个 handler 每个首行都调用它(`:903,948,970,1098,1048,1013`)。**新通道本身是有鉴权的,而且比无鉴权的 WS 更安全。** 它不启动任何服务、不绑定端口,全部挂在 AstrBot 自带 dashboard 下(`web_control.py:830-864`,`main.py:162`),**没有引入第三个端口**。

**真实风险因此变形而非新增**:
- 任意**已登录 dashboard** 的用户都能读全部会话历史、改桌面端本机配置 —— `_require_dashboard_user` 无 admin 位、无按 platform 授权。
- `get_overview:917-919` 直接回吐 `host` / `websocket_port` / `http_port`。
- `web_control.py:922` 读 `platform.transport._ws_client` **私有属性**判连接态。

所以现在的问题不是"多了一条无鉴权通道",而是**无鉴权的 WS 通道仍然存在,且与有鉴权的 HTTP 通道并存、读取同类数据**。

---

## P1-3 · 终态词表三份 —— 未变,且 OL V 流式新增了第二套执法点 🔴

第一轮的词表分歧原样保留:

- `turn-playback/session.ts:29-56` `TurnPlaybackPhase` **不含** `interrupted`,`TERMINAL_PHASES = {completed, failed}`
- `playback-timeline/playbackTimelineEngine.ts:64-66` `isTerminalPhase` **含** `interrupted`
- `playback-timeline/playbackTimelineRuntime.ts:1520-1522` `isTerminalSinkValue(value: string)` —— 用"排除 idle/started"实现,**参数未类型化**

**OLV 流式在此之上新增了同一不变量的第二个执法点**:

- `playbackTimelineRuntime.ts` 现在暴露**两个入口**:`startSegmentJob():433` 与 `startIncrementalMotion():453`
- `useTurnPlaybackOrchestrator.ts:37-39,53-63,64-68,105-113` 按 `segment.incremental` 分叉,增量分支从 `audio.terminal` + `motion.receivedAtMs/released/failed/completed` **重新推导**"动作能不能起"——而这套状态本已由 timeline engine 持有
- 非增量走 `isAtomicSegmentResolved():289-297`

**好消息:播放时钟没有分叉。** 全仓唯一 `createTimelineClock` 在 `playbackTimelineEngine.ts:72`。`pcmTimelinePlayback.ts:22` 契约明确「Binds PCM to the existing timeline; never creates another Turn or playback clock」,实现走 `attachAudioTimelineClock():132` / `markAudioTimelineTerminal():61`。**这一条做得对。**

---

## P0-新1 · 6 个补丁指向同一个架构缺口 🔴

新增的 OLV 流式在**同一处反复修补**,每次都加一条新逃生口而不是收紧不变量:

| commit | 规模 | 新增的逃生口 |
|---|---|---|
| `5dcb285` feat | +100 | 动作起在 PCM 时间轴上 |
| `32fcfa3` fix | +72 | **PCM 时长未知也可起** |
| `7fcf1a3` fix | +22 | 被拒动作要**结算**并重查窗口 |
| `d0cf84c` fix | +151 | 动作起在**剩余**音频时钟 |
| `bc6d6ca` fix | +42 | **无音频**也要结算/过期 |
| `fbb19ea` fix | +9 | 从 speech-only plan **预留**打开的动作 |

churn 集中度:`useModelEngine.ts` **68 次**提交、`playbackTimelineRuntime.ts` **57 次**、`useTurnPlaybackOrchestrator.ts` **40 次**。

**关键旁证**:OLV 之前刚完成播放归属收口 —— `eac4e14 refactor(architecture): consolidate playback ownership`、`0ffc33e refactor(architecture): enforce playback ownership boundaries` —— 流式在其上**重新撕开了口子**。同一个不变量现在有两个执法点:store 的 `rejectTerminalRewrite`(`useTurnPlaybackSessionStore.ts:541,613`)与 runtime 的 `rejectAudioBeforeStart`/`rejectMotionBeforeStart`。

**Recommended Direction**:把增量动作"可否启动"的判定收回 `playbackTimelineRuntime`,让 `startIncrementalMotion` 复用 `startSegmentJob` 的原子段解析,`useTurnPlaybackOrchestrator` 只做投影不做决策。这 6 个补丁指向的是同一个缺口。

---

## P0-新2 · ASR handoff 引入同一 turn 的双份转写 🔴

`c5c3ba5 feat(olv): add streaming ASR handoff review`(485 insertions)引入第二条 ASR 链路:

- 新增可选的插件内 sherpa-onnx 流式识别(`_conf_schema.json` +28 `fast_asr`)
- 本地识别后缓存原始 PCM(`speech_service.py:870-885`,TTL 120s / ≤8 条 / ≤12MB,**有界,这点做得好**)
- Core 判定任务交接时调 `review_audio_for_turn():887` 把 PCM 送 AstrBot STT 复核
- 发出**新协议消息** `output_transcription`(`types/protocol.ts`、`inboundOutputDispatcher.ts` +13、`inboundPayloads.ts` +13)

即**同一 turn 存在两份转写,后者覆盖前者**。紧邻的后续提交直接佐证:`ba357ef 修复了旧 ASR 抢占新预动作、异步取消归属…`、`366e392`。

**Needs confirmation**:`output_transcription` 到达时是否可能晚于该 turn 的动作已起播。

---

## P1-新3 · web 面板配置 spec 已漂移(今天就发生了) 🔴

前端方向是对的 —— `web-control/configSchema.ts:1-7` 明确不复制配置形状,只有类型 + 错误文案。

**但后端已经漂移**:

| | section 列表 |
|---|---|
| `_conf_schema.json` | `fast_asr, general, live2d_input, performance_curve, independent_motion, pre_action, passive_behavior, vad`(8) |
| `web_control.py:98-363` `CONFIG_SCHEMA` | `general, live2d_input, performance_curve, independent_motion, passive_behavior, vad`(6) |

**`fast_asr` 和 `pre_action` 缺失**。`fast_asr` 正是今天 `c5c3ba5` 刚加的 —— 当天就没进 web 面板。所谓 "single backend spec" 只相对前端成立,相对 `_conf_schema.json` 不成立。

缓解:`_project_settings:1388-1403` 只遍历 CONFIG_SCHEMA,`save_settings:1120-1124` 基于 `previous` 深拷贝 merge,**不会丢数据**,但页面静默不可编辑这两节。

**Recommended Direction**:让 `CONFIG_SCHEMA` 从 `_conf_schema.json` 生成,或加一条测试断言两者 section 集合相等。成本最低,直接消除已发生的漂移。

---

## P1-新4 · 编译产物入库,形成双份真相源 🔴

新引入,第一轮没有:

- `astrbot_plugin_ag99live_adapter/views/control-panel/assets/index-C_FRsMHl.js`(**178,663 字节**)与 `index-BcFcy8vy.css`(33,408 字节)已被 `git ls-files` 跟踪
- `.gitignore` 对 `views|control-panel|assets` 匹配数为 **0** —— 未被忽略
- `index.html` 确认引用 `./assets/index-C_FRsMHl.js`

问题在于:文件名带 **content hash**,每次构建都会变,而它必须与 `index.html` 的引用一致。同一面板因此同时存在**可审计源码**(`frontend/src/web-control/` 10 文件)与**不可审计产物**(178KB 压缩 JS)。提交 178KB 不可读产物换来的不是可复现构建,而是一个需要人工保持同步的 hash 契约。

**Recommended Direction**:入库可复现的构建产物或加构建校验,而不是让 hash 契约靠人工维持。

---

## P1-新5 · 双 UI 编辑同一设置,跨窗口不同步可达 🔴

**先更正第一轮的一个假设**:两条路径**最终收敛到同一 store**,不是"各改一半"。

| 设置 | web-control | 设置窗口 |
|---|---|---|
| `speech_volume` | broker → `saveSpeechVolume`(`useAdapterConnection.ts:388`) | `applySpeechVolume()`(`useSettingsWindow.ts:225-227`) |
| `model_view_scale` | `:390` | `:229-231` |
| `ptt_mode_enabled` / `ptt_key_binding` | `:384,386` | `bridge.sendCommand("set_ptt_mode")`(`useDesktopRuntimeCommandHandler.ts:167-172`) |
| `esp32_*`(11 项) | `applyEsp32DisplayConfig` | `useEsp32DisplaySettings.ts` |
| `spout_enabled` | `applySpoutEnabled` | `useSpoutSettings.ts` |

**但两个具体缺陷是真实的**:

1. **同一字段边界声明三处**。ESP32 crop:Python 静态 `crop_x max=1`(`web_control.py:614-621`)vs 桌面动态 `maximum: 1 - config.crop.x`(`desktopSettings.ts:378-381`)。桌面在线时 broker 覆盖生效(`:1036-1043`),**桌面离线时走 `:1022` 返回 Python 静态边界** → 页面显示错误的可填范围。
2. **跨窗口同步不一致,真可达**。spout(`useSpoutSettings.ts:86-108`)和 esp32(`useEsp32DisplaySettings.ts:106-131`)有 BroadcastChannel + `storage` 监听;但设置窗口的 `storage` 监听**只覆盖 4 个 pet-preference key**(`useSettingsWindow.ts:238-248`)。PTT、截图、`persona_segment_stream`、`adapter_address` 存于适配器连接状态,web-control 改动后**已打开的设置窗口不会刷新**。*Needs confirmation:设置窗口是否在 focus 时重读。*

---

## P2-11 · ESP32 静默 —— 部分修复 🟡

- ✅ 已修:`useEsp32DisplayConnection.ts:99`、`:144` 现在有 `console.warn`(`ipc_status_failed` / send frame failed)
- ❌ 未修:`useEsp32DisplayPipeline.ts:210`、`:224`、`:235` 三条 catch 仍只写 `lastError.value` 后 `return`,无 console、无 history;`:258-261` 断连/`enabled=false` 分支静默重置计数器
- ❌ `enabled` 分裂未变:读取强制 false(`:30`)、写盘强制 false(`:46`),但跨窗口同步路径保留真值(`:120-126`)→ 会话内生效、重启后静默回落

---

## P2-10 / P1-8 / P3-14 · 完全未变 🔴

- **inbound 死依赖存活**:`inboundDispatcher.ts:116` `buildInboundEventContext`;`inboundEvents.ts:189` 参数仍 `_ctx` 且零引用;`adapterInboundRuntime.ts:164-167` 定义、`:97`/`:160` **每条消息都构造**、`:235` 塞进 deps、`:260` 对外导出。两张同构 switch 仍在(`inboundEvents.ts:191` / `inboundDispatcher.ts:131`),`motion_lab_raw_event_recorded` 仍在顶层绕过 feature dispatcher(`:144-145`)。
- **视图内嵌业务逻辑未变**:`SemanticAxisProfileEditor.vue:491` 校验 + 环检测仍在组件内;`BaseActionPreviewPanel.vue:140` 内联 plan 编译器未提取,且 `:382` `buildSemanticAxisValuesFromAtoms` 是 `:339` `buildAxisValuesFromAtoms` 的别名直转(自身就有概念重复)。
- **文档漂移未变**:`docs/01-架构与结构/01-项目总览与模块职责.md:33-43` 结构图仍只列 4 个目录,**不含 `render-core`/`runtime-core`**;新增的 `07-动作生成与Persona分段关联.md` 也未提原生平面。全目录 grep `render-core|runtime-core|原生` 只命中"原生麦克风"(指 Electron 原生模块,与原生平面无关)。

---

## 更正:第一轮的一处误判

第一轮 P1-5 描述"条件不成立时 `current_turn_id` 保持旧值,与 `_turn_terminal_results` 已终结的事实不一致"——**这个描述是错的**。

当前 `turn_coordinator.py:859-860`:
```python
if self.session_state.current_turn_id == resolved_turn_id:
    self.session_state.reset_to_idle()
```
条件**不成立时本就不应清理**,否则会抹掉更新 turn 的 `current_turn_id`。这是正确设计。

结构本身(turn 终态由 `_turn_terminal_results:168` 与 `session_state.current_turn_id:24` 双轨表达)仍在,但原来的缺陷指控不成立。`turn_coordinator.py:622-625` 那处只清 `turn_identity_map`、不动 session_state,也是正确的。

---

## 建议顺序(按性价比)

1. **P1-新3** 让 `CONFIG_SCHEMA` 从 `_conf_schema.json` 派生,或加 section 集合相等断言 —— 成本最低,消除已发生的漂移。
2. **P1-新4** 决定 178KB hash 产物是否入库,并加构建校验。
3. **P0-1** 让 C++ 协议常量由 manifest 生成,并把约束纳入校验脚本 —— 这是原生运行时能继续用的前提。
4. **P0-新1** 把增量动作启动判定收回 `playbackTimelineRuntime` —— 那 6 个补丁指向同一个缺口,越晚收敛补丁越多。
5. **P2-10 / P1-8 / P3-14** 纯类型与文件级收敛,风险低,可并行。
6. **P1-7** WS 鉴权需要产品决策(是否有反向代理兜底),不宜单方面改。

---

## 本轮未覆盖 / 未验证

- **未运行** typecheck / test / pytest / CMake 构建。唯一实际执行的是 `python scripts\check_protocol_schema_manifest.py`(**EXIT=0**,该结果本身是 P0-1 的证据)。
- **未复核**:P1-6(媒体失败致 turn 二次失败)、P2-12(失败静默)、P2-9(快照三重深拷贝,仅有 `51b11d4 perf(frontend): reduce runtime snapshot duplication` 提交,未逐条确认)。
- **未取证**:`vts-data-recorder/`、`frontend/native/spout/`、web-control 的构建流程。
- **仓库外依赖**:AstrBot 如何填充 `g.username`、dashboard 本身是否强制登录,均未验证 —— 故 P1-7 中"实际是否可被未授权访问"只能确认代码层无自定义鉴权缺口。
- 工作区干净(`git status --short` 无输出),本轮未修改任何文件。
