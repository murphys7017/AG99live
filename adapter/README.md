# adapter

这里是 AG99live V2 的适配器侧目录。

当前阶段对 `adapter` 的执行策略已经明确：

1. 先迁移 V1 中已经稳定可用的适配器底座
2. 再单独重写模型系统

也就是说，V2 适配器的第一批工作不是从零写一套全新后端，而是：

- 先把消息桥接、基础协议、会话状态、传输骨架迁过来
- 先保证 V2 有一个能工作的适配器基础版本
- 再把模型扫描、模型配置、基础能力产物生成这一部分重新设计

## 当前阶段建议

迁移时应分成两类内容：

### 可以先迁移的

- 协议桥接
- WebSocket 传输
- turn 协调骨架
- 会话状态
- 历史记录桥接
- 媒体缓存与静态资源服务

### 需要后续重写的

- 模型信息系统
- 模型扫描逻辑
- 基础配置 / manifest 生成逻辑
- 旧的动作 / 表情映射主路径

## 当前目标

当前 `adapter` 目录的目标不是立刻完整，而是先明确迁移顺序：

**先保留 V1 的桥接价值，再替换 V1 的模型系统。**

## 动作计划链路

- 主链路：`TurnCoordinator._commit_inbound_message()` 会在提交 AstrBot 事件前，把内联动作契约注入 `event.message_str`。
- 输出格式：主模型正常回复文本后，最后一行仅输出一个 `<@anim {...}>` 标签。
- 提取位置：`TurnCoordinator.emit_message_chain()` 会剥离 `<@anim {...}>`，文本继续走 `output.text`，动作部分转为 `engine.motion_plan`。
- 兜底路径：主回复没有合法 `<@anim {...}>` 时，才触发 `realtime_motion_plan` 二次请求。

## 相关配置

- `enable_inline_motion_contract`：是否向主聊天请求注入 `<@anim ...>` 输出契约，默认 `true`。
- `enable_realtime_motion_plan`：是否保留回复后二次动作计划生成兜底，默认 `true`。
- `realtime_motion_timeout_seconds`：二次动作计划生成超时时间，默认 `8.0`。
