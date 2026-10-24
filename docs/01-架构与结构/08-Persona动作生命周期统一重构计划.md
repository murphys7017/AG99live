# Persona 动作生命周期统一重构计划

更新：2026-10-24

## 目标

把 Persona 回复段、动作生成、TTS 绑定、增量输出和 Motion Lab 记录统一到一个可验证的生命周期模型中，停止通过 event extra、临时字典和分支补偿来维护同一段落的状态。

这项工作解决的是内部状态一致性和可诊断性问题。它不以新增动作能力、提升 Provider 速度或改变前端协议为目标。

## 复核结论

本轮对照了以下实现和契约：

- `main.py` 的 Persona 段 intent-ready、segment-ready 和结果回调
- `platform_event.py` 的 OLV writer、pending、delivered 和 future 状态
- `runtime/persona_stream_motion.py` 的跨任务动作 registry
- `middleware/interaction_motion/scheduling.py` 的动作汇合、TTS 绑定和观测记录
- `motion/observation.py` 的 Persona 样本写入
- Persona 分段关联、OLV 生命周期、协议身份和训练样本契约文档

复核确认以下问题确实是共性问题：

1. 同一个 Persona 段落没有唯一的内部状态对象。身份、动作结果、TTS 绑定和发送状态分散保存。
2. `turn_id`、`persona_result_id`、`segment_index`、`segment_message_id` 等身份由多层函数手工传递，缺失字段不会在边界处立即失败。
3. Provider 生成、规范化、TTS 绑定、wire 发送和客户端执行没有统一状态机，单个 `status` 或局部布尔字段容易产生语义混淆。
4. M0、M1、M2 使用相似但不一致的路径，差异被写进业务分支，而不是限制在 delivery adapter 内。
5. 失败、超时、取消和身份冲突不是与成功同等完整的生命周期结果，部分路径仍直接跳过失败结果。
6. Motion Lab 当前主要通过追加快照拼接样本，没有中心化 reducer 对阶段完整性和身份一致性做校验。
7. 现有测试覆盖了若干局部边界，但没有覆盖完整的生命周期转移矩阵和真实跨层链路。

因此，问题不是继续缺少某个参数，而是状态所有权和生命周期边界没有落成代码结构。

## 目标模型

### Turn 会话

新增一个 Adapter 内部的 `PersonaTurnSession`，负责一次 Persona Turn 的所有段落和取消范围。它拥有：

- Turn 身份和 Core 身份
- Persona 结果集合
- 段落集合
- delivery mode
- Turn deadline 和取消状态
- 生命周期事件入口
- 样本归约入口

### 段落状态

每个段落使用强类型 `PersonaSegmentState`，统一保存：

```text
identity:
  turn_id
  core_turn_id
  persona_result_id
  segment_index
  segment_count
  segment_message_id
  sequence

content:
  speech
  actions
  tendency

provider:
  request_id
  prompt
  raw_output
  normalized_payload
  status
  failure_reason

delivery:
  mode
  tts_request_id
  binding_status
  wire_status
  execution_status

control:
  deadline
  cancelled
  terminal_reason
```

### 生命周期

段落生命周期拆分为身份/内容、动作生成、绑定、交付、客户端执行和样本归约轨道。它们通过段身份关联，但不强行串成一个线性状态。Persona Effect 不经过 Provider；M2 的动作候选可能在 Provider 请求结束前进入 writer。

```text
identity/content: admitted -> intent_ready -> segment_ready
motion/effect:    not_requested -> effect_received -> normalized | failed
motion/provider:  requested -> candidate* -> normalized | failed | timed_out | cancelled
binding:          unbound -> bound | binding_failed | not_applicable
delivery:         not_started -> open -> update* -> ended | failed | cancelled
execution:        not_received -> accepted/running -> completed | failed | cancelled
sample:           facts* -> incomplete | complete | rejected
```

Provider 状态、输出发送状态和客户端执行状态必须分别保存，不能用一个字段代替三个层次。每条轨道只由其事实所有者推进；一个轨道的成功不能代替另一个轨道的成功。

### M0、M1、M2 边界

M0、M1、M2 共享同一个 `PersonaSegmentState` 和生命周期。三者只在 delivery adapter 中决定：

- 何时收到段落
- 如何绑定 TTS
- 使用完整输出还是 OLV writer
- 如何向客户端发送

它们不能各自创建一套 pending、started、delivered 和失败状态。

### 观测模型

生命周期事件由统一 reducer 汇总为一个 Persona 样本。事件记录保留原始事实，但最终训练样本必须由 reducer 生成，并检查：

- 身份是否完整
- 同一身份字段是否冲突
- 必需阶段是否存在
- 失败是否有明确原因
- Provider 状态是否被误当成 wire 或执行状态

## 分阶段实施

### 阶段 0：冻结行为和清点状态

工作内容：

- 列出所有 Persona 段状态的写入点和读取点
- 为每个 event extra、registry 字段和临时字典标记所有者
- 冻结当前外部协议、配置字段和 Motion Lab 样本字段
- 标记必须删除的重复路径和仅用于内部兼容的 wrapper

完成标准：

- 形成一张字段所有权表
- 形成 M0/M1/M2 的当前调用链图
- 不新增功能，不改变外部行为
- 阶段 0 基线记录在[Persona 动作生命周期阶段 0 基线](09-Persona动作生命周期阶段0基线.md)

### 阶段 1：建立统一身份和值对象

工作内容：

- 新增不可变的 `PersonaTurnIdentity` 和 `PersonaSegmentIdentity`
- 所有跨层调用改为接收身份对象，而不是分别接收多个字符串和索引
- 在入口处统一校验非空、类型、索引范围和身份冲突
- 暂时保留现有 delivery 行为，但让它们从统一身份对象读取字段

完成标准：

- 新增调用不能绕过身份校验
- 旧的手工身份拼接点明显减少
- M0/M1/M2 输出字段保持兼容

### 阶段 2：建立段落状态对象和状态转换

工作内容：

- 用 `PersonaSegmentState` 替换 `dict[str, Any]` work 结构
- 把 Provider、TTS、OLV 和取消状态迁入该对象
- 用显式方法执行状态转换，拒绝非法回退和跨结果写入
- 将 `pending`、`started`、`delivered` 等重复状态收口到状态对象内部

完成标准：

- registry 只保存会话/段落对象，不再保存无结构动态字典
- 状态转换有统一入口
- 迟到结果、重复 hook、取消和身份冲突都有确定结果

### 阶段 3：收口 M0/M1/M2 delivery adapter

工作内容：

- 把完整输出、Persona 段流和 OLV writer 的差异移入 adapter
- 调度器只负责提交动作意图和接收生命周期结果
- 删除重复的 whole-result、segment-result 和 TTS 补偿分支
- 删除无外部兼容要求的内部 fallback、wrapper 和双路径

完成标准：

- 三种 delivery mode 共用同一段落生命周期
- 调度器不再直接维护多套发送状态
- 任何 delivery 失败都能回写统一段落状态

### 阶段 4：重做 Motion Lab reducer

工作内容：

- 将现有 `motion.persona_sample.v1` 事件视为事实事件
- 新增按 `sample_id` 聚合的 reducer
- 为成功、失败、超时、取消、身份冲突生成完整终态样本
- 明确训练数据视图与运行时诊断视图的区别

完成标准：

- 每个段落都有一个可解释的最终样本
- 失败样本不会因为没有 payload 而消失
- 训练导出不依赖事件到达顺序

### 阶段 5：验证和删除旧路径

工作内容：

- 添加生命周期转移矩阵的边界验证
- 进行真实 Core、Provider、TTS、OLV 和 Live2D 联合验收
- 删除已被统一模型替代的 event extra、临时字典和重复逻辑
- 更新架构文档和运行时排障文档

完成标准：

- 静态检查、边界验证和真实运行日志相互一致
- 没有遗留的双重状态所有权
- 旧路径删除后，失败和取消行为仍然可诊断
- 生产代码净变化必须以阶段 0 开始时记录的重构文件快照为基线统计：重构涉及的生产文件删除行数大于新增行数；测试和文档分别统计，不抵消生产代码新增。不得直接用包含用户既有未提交改动的当前 `git diff --numstat` 代替该基线统计。

## 第一阶段明确不做的事情

- 不接入 NeuroBrain 的连续状态实现
- 不训练新的小模型
- 不改变 Persona 输出结构和 OLV 公共协议
- 不重写 C++ 验证工程
- 不继续扩展 Motion Lab 字段
- 不通过兼容 wrapper 保留已经废弃的内部路径
- 不把现有局部测试通过当作端到端验收

## 主要风险

- Core、Adapter 和桌面端的生命周期契约必须保持一致，任何一端单独加载都会造成假成功。
- 现有工作区包含未提交的用户修改，重构时必须逐文件确认归属，不能整目录覆盖。
- 删除内部旧路径前，需要确认没有外部插件或旧 Core 版本依赖它们。
- 真实 Provider、TTS、桌面播放和 Live2D 仍需要现场验证，静态检查不能代替运行验收。

## 当前决策点

后续实现从阶段 0 基线开始：字段所有权表、M0/M1/M2 调用链图和分轨状态转移表已形成后，再编写统一身份对象。按此顺序推进，不在基线完成前大规模删除或重写调度逻辑。
