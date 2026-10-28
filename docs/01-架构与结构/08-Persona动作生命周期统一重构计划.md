# Persona 动作生命周期统一重构计划

更新：2026-10-28
状态：阶段 1-5 已完成源码实施与复核；阶段 6 的目标环境验收尚未开始。

## 目标

逐步减少 Persona 回复段、动作生成、TTS 绑定、输出交付和 Motion Lab 记录之间的状态重复与身份歧义，让每个状态事实有明确所有者、合法转移和可诊断结果。

本计划处理 Adapter 内部的状态所有权和生命周期边界，不新增动作能力、不改变用户可见行为、不改变 Core 输出结构或桌面协议，也不把 Provider 成功等同于动作已发送或已执行。

## 2026-10-28 阶段 2 实施前复核记录

此前计划中的部分目标已经进入代码，文档不能再按“尚未开始”安排：

- runtime/persona_lifecycle.py 已定义不可变的 PersonaTurnIdentity、PersonaSegmentIdentity，并有 PersonaTurnSessionRegistry、PersonaTurnSession、PersonaResultState 和 PersonaSegmentState。目前跨层调用仍主要传递独立字符串、索引和字典，身份值对象尚未成为统一的内部调用边界。
- Turn/Result/Segment 的对象层级、任务登记、取消、TTS binding 和部分状态校验已经存在。状态仍未完全收口：PersonaResultState.delivery_state 是动态字典；Provider、wire、取消等字段在状态对象中直接写入；M2 writer、M0/M1 输出协调器和平台事件也各自保留传输状态。
- 原先独立的 Persona 动作 work registry 已由 PersonaTurnSessionRegistry 承担主要职责，但不能据此认定所有重复状态和临时容器都已消失。
- Motion Lab 已有按 sample_id 归并事件快照、检查身份/路由/模式冲突、生成审核清单及导出人工批准样本的 CLI。它是离线训练样本投影，不是运行时生命周期 reducer；失败、超时、取消等诊断终态仍需确认能否从事实事件中稳定区分。
- M0/M1 的完整段交付由 OutputSegmentCoordinator 管理，M2 由 OLV writer 管理。两种协议的发送状态有真实差异，应统一生命周期边界和归属规则，不强行变成同一套 wire 状态字段。
- 桌面播放/Live2D 执行状态属于客户端事实；Adapter 不能从 Provider 完成或 WebSocket 发送成功推断执行成功。
- Motion 来源路由已在 OLV 事件创建时固定，并被后续分段调度和 TTS 身份记录复用；这一项已有实现，不再列为待办功能。

因此，下一步不是重建基础对象或重做现有数据导出工具，而是确认每条状态轨道的唯一事实所有者，再按该边界收口跨层身份和状态转移。

## 阶段 3 执行记录（2026-10-28）

- `PersonaResultState.delivery_state` 已替换为 `PersonaDeliveryAssemblyState`。它只保存 segment indexes、TTS fallback template、streaming 标记和 delivery completion latch；`expected_segment_count` 与 `stream_status` 分别由 Result 独占。
- Registry 按 Core Turn ID 查找生命周期状态；frontend Turn ID 继续由输出协调器和 OLV writer 持有。终止 hook 校验 frontend/Core 映射后才推进 Result terminal。
- 删除 `PersonaSegmentState.provider_result`。Provider 结果只通过 `result_future` 交给等待方；Result terminal 取消未完成 Provider 任务和 Future，Turn/Result 清理也取消其注册任务与句柄。已退役 Result ID 和最近 256 个关闭 Turn ID 拒绝重新 admission。
- M2 motion payload、pending fact、payload 去重、revision 和 resource terminal 现在只由 `IncrementalOutputSession` 保存。motion stream 启动前到达的最后一个 fact 由 writer 暂存并在 start 后发送；平台事件只提交结果事实。
- 移除 PersonaSegmentState 与平台事件中的 wire 镜像字段、未使用的 wire Future 和首次动作输出时间戳。后者在仓库内无读取方，且 pending 时无法准确表示实际发送时间。
- 终态允许与输出完成乱序到达；完成后清理 assembly 索引和模板，但保留轻量 completion latch，直到 Result 清理，避免迟到 hook 重建装配状态。

本地源码复核、Python `compileall` 和 `git diff --check` 通过。当前环境未安装 Ruff，本轮未运行测试；Core OLV producer 在 Provider Future 被取消时如何关闭 open motion stream，以及 Core、Provider、TTS、M0/M1 v6、M2 OLV、桌面和 Live2D 联合行为，仍待目标环境验收。

## 目标模型与约束

Turn session 负责 Turn 身份、Persona result/segment 索引、协作任务和取消范围。Segment identity 是跨 Core hook、Provider、TTS、交付和观测关联的内部身份。状态对象只保存确实由该对象负责的事实，不为追求“统一”而复制其他组件的权威状态。

状态按事实轨道分别定义，不使用一个总状态枚举串行描述整个段落：

~~~text
identity/content: admitted -> intent_ready -> segment_ready
motion/effect:    not_requested -> effect_received -> normalized | failed
motion/provider:  requested -> candidate* -> normalized | failed | timed_out | cancelled
tts binding:      unbound -> bound | binding_failed | not_applicable
wire delivery:    not_started -> open -> update* -> ended | failed | cancelled
client playback:  not_received -> started -> completed | failed | cancelled
sample collection: facts* -> open -> closed | incomplete
sample quality:    unknown | blocked | reviewable
~~~

各轨道通过已校验的段身份关联，由产生该事实的组件推进。下游可以接收不可变结果或观测事件；不得再创建同一事实的第二份可变状态。Provider 候选、Provider 终态、wire 终态和客户端播放终态必须保持可区分。M2 可在 Provider 终态前发送候选；Persona Effect 不经过独立 Provider。

样本的采集闭合与训练审核质量是两个维度。`open` 表示没有记录到可识别的来源终态；这无法区分仍在进行与取消但未落盘，因此不得推断取消。来源报告正常终止时标为 `closed`，即使训练字段缺失也由质量状态标为 `blocked`；明确失败、超时、取消或终态冲突标为 `incomplete`。`blocked` 表示事实冲突、动作失败或训练必需字段不满足；`reviewable` 表示满足人工审核输入条件，不代表已经批准。缺少有效 `sample_id` 的 raw event 不归入样本，必须保留为可诊断的 malformed 事件计数与事件身份，不伪造样本身份。现有 `motion.persona_sample.v1` 不记录 M2 wire 终态，也不一定记录取消的终态事件；归约器只使用已经存在的来源事实，不推断缺失事实。

M0、M1、M2 是交付模式；persona_effect 和 independent_motion 是动作来源，两个维度不能互相替代。共享身份、结果语义和失败解释；协议不同的 wire 状态由对应交付组件负责。

## 分阶段计划与当前状态

### 阶段 0：建立并刷新基线（已完成）

2026-10-24 的字段表、调用链和状态轨道作为历史基线保留；2026-10-27 的源码复核与完成度记录在[阶段 0 基线与当前复核](09-Persona动作生命周期阶段0基线.md)。

后续不得把 10 月 24 日的历史字段表误当成当前代码，也不得用含用户未提交改动的整个工作区差异推算本次重构行数。本计划取消“生产代码删除行数必须大于新增行数”的验收门槛；它不能证明状态所有权正确，也没有可靠的生产文件快照作为统计基线。

### 阶段 1：冻结状态所有权与转移契约（已完成：2026-10-28）

当前源码已具备 Turn/Result/Segment 对象和基础身份类型，但所有权边界尚未冻结。本阶段只完成源码盘点、矩阵和转移规则，不迁移调用点。

工作内容：

- 在阶段 0 当前状态表后冻结事实所有权矩阵，区分权威状态、关联索引、协作句柄和不可变观测副本。
- 按 M0、M1、M2 写明身份到达时点、可缺省字段、重复/冲突行为、终止方和清理时机。
- 明确样本采集闭合事实与质量审核状态；若当前 raw event 无法证明闭合，只允许先标为未知并列出最小缺口，不推断成功或失败。
- 本阶段不得改变生产代码、Core 输出结构、WebSocket/OLV 协议或训练 schema。

完成标准：

- 当前实现与目标所有者逐项对应，未确认事实明确标为待验证。
- 每条状态轨道都有合法转移、拒绝条件、终态、幂等规则和清理责任。
- 矩阵进入[阶段 0 基线与当前复核](09-Persona动作生命周期阶段0基线.md)，后续代码阶段只按此矩阵执行。

### 阶段 2：统一内部身份边界（已完成：2026-10-28）

复用已有 PersonaTurnIdentity、PersonaSegmentIdentity；不重建对象。依照阶段 1 矩阵，把值对象用于生命周期 Registry、段级 admission、Provider 调度和 TTS 绑定。Motion Lab serializer 在生成既有 raw-event schema 时再投影为标量字段，以保留可为空的 Core/result 身份事实。

工作内容：

- 逐个迁移已盘点的内部调用边界；身份只在 Core/AstrBot/Provider/客户端协议及 Motion Lab raw-event schema 边界转换为标量。
- 统一入口校验 Turn、Result、Segment 的归属、索引范围、消息 ID 冲突和重复 hook。
- 保留外部 payload、训练样本字段和 M0/M1/M2 时序。

完成标准：

- 生命周期 Registry 的内部入口不再分别传递同一组 Turn/Segment 标量。
- 非法身份在边界入口失败；重复/冲突不会创建第二份生命周期状态。
- M0/M1/M2 外部 payload 和时序不变。

### 阶段 3：收口类型化状态转移（已完成源码实施：2026-10-28）

工作内容：

- 用明确类型替换 `delivery_state` 动态字典，只保存 Adapter 对 Core 段流汇总实际拥有的事实，不混入 v6/OLV wire 终态。
- 移除重复的 Provider 结果缓存；以唯一结果句柄/结果对象供等待方消费。
- 将 M2 的 motion stream 去重、revision、pending 和终态收归 OLV writer；平台事件只提交事实，不镜像 writer 状态。
- 移除无消费者的状态字段与重复赋值路径；每个转换方法定义幂等、拒绝和终态后行为。
- Turn/Result 取消只终止其注册任务；已终止对象拒绝迟到 Provider/TTS/hook 结果，不复活或跨身份投递。

完成标准：

- 状态字段都有矩阵中的唯一所有者；临时索引不被当成权威状态。
- Core 段流完成状态与 M0/M1 wire、M2 wire、客户端播放状态可分别查询和解释。
- 重复、迟到、超时、取消、清理的边界行为符合矩阵。

本阶段已完成静态源码路径收口；独立 Runtime 行为和目标环境联合验收仍由阶段 6 完成，不以编译通过替代现场证据。

### 阶段 4：整理 M0/M1/M2 生命周期适配（源码复核完成：2026-10-28）

工作内容：

- 让三个模式在相同的身份校验、动作结果语义、失败解释和观测边界汇合。
- 保留 M0 完整结果后逐段处理、M1 Persona 段增量形成后走完整 v6 段交付、M2 OLV 多资源流的时序差异。
- 仅在确实消除重复控制流时增加共同 delivery 接口；协议专属状态继续由对应 writer/coordinator 持有。
- 根据阶段 1 所有权表删除已被取代的内部 fallback、wrapper 和重复状态写入。

完成标准：

- 三种模式都能按同一 Persona 段身份追溯输入、动作结果和交付结果。
- 每种 wire 终态只有对应交付组件推进，调度层不再维护第二份发送状态。
- 失败不会丢失文本/音频既有语义，也不会被错误映射为无动作或成功。

2026-10-28 源码复核结论：M0 等完整 Result task 后逐段形成 v6 交付；M1 在 Persona 段 ready 后用该段 Future 和 TTS binding 汇入 v6 finalizer；M2 复用同一 Result/Segment 身份，但由 IncrementalOutputSession 独立推进 text/audio/motion wire。M0/M1 的 Provider 失败进入 v6 motion failure schedule，M2 的无 payload 结果以 failed motion end 收口，核心文本/音频在各自交付路径继续处理。三种路径共享身份和 Provider 结果语义，wire 控制流没有足够重复需要新增共同 delivery 接口；保留协议专属 writer/coordinator 更符合所有权矩阵。源码复核未做目标 Core/Provider/TTS/OLV/桌面联合验收，该证据仍归阶段 6。

### 阶段 5：补齐 Motion Lab 诊断归约（源码实施与复核完成：2026-10-28）

已有离线 reducer、审核清单摘要保护和人工批准后训练导出。下一步只补已确认的生命周期缺口，不重写已有工具。

工作内容：

- 对照阶段 1 的轨道和事实事件，验证成功、失败、超时、取消、身份冲突分别能否在归约结果中解释。
- 将采集闭合状态与质量状态分开；明确 malformed、open、closed、incomplete、blocked、reviewable 对应的事实与导出行为。
- 缺少 `sample_id` 的原始事件继续留在 raw store，并在诊断摘要中列出事件 ID/type 与数量；不得只静默跳过，也不得伪造关联。
- 保留按 sample_id 汇总、独立来源/模式筛选、不可编辑事实摘要和人工批准门槛。
- 只有当事实缺口无法由当前事件表达时，才提出最小的 raw-event schema 扩展；先记录缺口及影响，再单独评估。

完成标准：

- 同一组事实无论写入数据库的顺序如何，归并身份与终态一致；冲突事实显式阻断并保留冲突字段。
- 已记录的失败/取消/冲突样本不会静默消失，也不会成为可导出的成功训练样本。
- Provider 候选、最终 Provider 结果、wire 发送和客户端播放各自有清晰字段与解释。

2026-10-28 执行记录：归约器把采集状态 `open/closed/incomplete` 与质量状态 `reviewable/blocked` 分开；仅无终态事实保持 `open`，成功 Provider/Effect 结果为 `closed`，失败、超时、明确取消和终态冲突为 `incomplete`。未发现终态的取消不会被猜测，仍记录为 open 并附 `no_terminal_motion_result`。训练导出仅接受闭合样本；审核 schema v2 会校验数据库版本、筛选器、样本计数、诊断列表、采集状态、质量/审核字段和不可变摘要。缺失或无效 `sample_id`、非法 JSON、非对象 JSON、错误样本 schema 的事件保留 event ID/type/reason 诊断，不伪造样本。身份、来源、模式、Persona 意图、动作终态、payload 及互相矛盾的客户端播放终态保留冲突值和来源 event IDs，并阻断质量审核。训练 schema v1、raw-event schema v3 和桌面协议未变。Python 编译、CLI help、YAML parse 和 diff whitespace 检查通过；未运行测试或读取真实 Motion Lab 数据库，故不构成目标环境采集验收。

### 阶段 6：分层验收并删除旧路径（未开始）

工作内容：

- 按阶段 1 矩阵和各轨道转移做最小静态与边界检查，检查真实调用链，不用局部通过代替端到端证据。
- 在目标环境验收 Core、Provider、TTS、M0/M1 v6、M2 OLV、桌面播放和 Live2D。
- 依据阶段 1 所有权表删除旧 event extra、动态容器和重复路径；删除前确认调用方和取消语义。
- 更新生命周期、排障和样本契约文档。

完成标准：

- 代码事实、日志和用户可见行为符合状态转移表。
- 不存在同一事实的双重可变状态所有权。
- 目标环境日志能区分 Provider、wire 和客户端终态；静态检查不会被表述为现场验收。

## 明确不纳入本轮

- C++ 高性能验证工程。
- 连续存在感/注意力表现层和桌面观察行为。
- NeuroBrain 测试插件或任何连续态接入。
- 新的小模型训练、训练任务提交或 Motion Lab 图形审核界面。
- 未经事实缺口证明的 Motion Lab schema 扩展。
- Persona 输出结构、OLV、WebSocket 或桌面客户端协议变更。
- 为追求净删除行数而进行的代码改写。

## 风险与执行约束

- Core、Adapter、TTS、OLV writer、v6 输出协调器和桌面端共同构成生命周期；单端静态检查不能证明完整链路。
- 当前工作区在 main.py、调度、观测、平台事件、训练契约和其他文件有未提交改动。后续实施必须逐文件确认上下文并保留用户修改，不覆盖或清理无关工作。
- 删除内部实现前按仓库约定统一调用方，不以兼容 wrapper 或平行路径延长旧实现。
- 阶段 1 是文档门槛；进入阶段 2/3 前不得以局部实现替代完整矩阵。实时 Core/Provider/TTS/Live2D 验收需在目标运行环境单独完成。

## 下一步决策点

阶段 0-5 已完成源码实施与复核；下一步进入阶段 6，先做最小边界验证，再在目标环境确认新采集、Core/Provider/TTS、M0/M1 v6、M2 OLV、桌面播放及 Live2D 的联合行为。当前没有目标数据库事实证明需要扩展 raw-event schema；代码未改变训练 schema、Core 输出结构或 WebSocket/OLV 协议。
