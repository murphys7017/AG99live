# AG99live Adapter

AG99 插件 `astrbot_plugin_ag99live_adapter` 将 AG99 的对话、TTS 和动作结果接入 AG99live 桌面端。动作可由 Persona Effect 或独立 Provider 生成。当前版本为 **1.1.0**，协议版本以 `protocol/schema_manifest.json` 为准。本版本与 AG99live 桌面端 `0.1.0` 安装包配套。

## 职责

- 接收文本、流式麦克风、图片和平台事件输入，并提交到 AG99 的正常对话流程。
- 收集一条逻辑消息的文本、TTS、动作和媒体，提交原子 `output.segment` 消息，其 Payload Schema 为 `output.segment.v5`。
- 校验 `ag99live.motion`，提供模型扫描、profile、动作资源和媒体的本机服务。
- 管理 Turn、段、取消、Motion Lab 记录、可选 performance curve 与连接清理。

它不将语义动作转换为 Live2D 参数，也不创建前端播放时钟或默认动作。

## 运行接口

默认服务仅绑定 `127.0.0.1`：

| 服务 | 默认端口 | 作用 |
| --- | ---: | --- |
| WebSocket | `12396` | 输入、输出、控制、模型与系统消息。 |
| HTTP | `12397` | 已扫描模型、缓存音频、图片和允许的静态资源。 |

端口由插件根配置的 `port` 和 `http_port` 设置。其他常用根配置包括 `speaker_name` 和 `auto_start_mic`；运行资料归入 `general`、`live2d_input`、`performance_curve`、`independent_motion` 与 `vad`。请使用 AG99 当前插件 Schema 生成或编辑配置，旧平级路径不再读取。

### 身份字段

AG99 的平台配置和插件的 `general` 配置使用的是两套身份，不能混为一个“用户 ID”：

- `olv_pet_adapter` 是固定的适配器类型，不是桌宠名称，也不是用户 ID。
- AG99 平台配置中的 `id`（界面可能标成“机器人名称”）是具体的**桌宠实例 ID**，例如 `aki`。它用于区分连接实例、作为平台路由键，并作为入站消息的 `self_id`；多个桌宠实例必须使用不同值。
- 插件 `general.client_uid` 是桌面端消息客户端的**会话/发送者 ID**，例如 `desktop-client`。它不是桌宠实例 ID，也不是 AG99 WebUI 登录用户账号。注意它当前属于插件级配置，所有 Adapter 实例共用同一个值；当前不能为每个桌宠实例分别设置。
- 插件 `general.client_nickname` 是桌面端消息在 AG99 中显示的发送者名称。
- 平台配置的 `speaker_name` 是桌宠回复侧的说话人名称，不承担实例寻址或用户身份作用。

当前适配器实际读取的平台字段是 `id`、`enable`、`port`、`http_port`、`speaker_name` 和 `auto_start_mic`；旧配置中若仍看到 `host`、`debug_port` 或 `conf_name`，它们不会改变当前运行时行为。

## 动作路径

```text
AG99 Persona
  -> ag99live.motion
  -> Adapter 严格校验
  -> engine.motion_intent.v4
  -> output.segment（schema: output.segment.v5）
  -> 前端 ModelEngine
  -> engine.parameter_plan.v3 或受控资源执行
```

动作生成依赖 AG99 Persona 扩展或兼容的 Persona 生命周期能力；官方 Core 不支持这些扩展时，Adapter 仍可转发对话和 TTS，但不生成动作。

动作输入选择 `axis_levels`、稀疏 `motion_steps` 或 `motion_resource_id` 之一。未知轴、非法等级、空 step、形态冲突和无效资源会明确失败；Adapter 不补轴、不改名、不生成 neutral pose。

### 动作生成模式

`independent_motion.enabled` 默认关闭。关闭时使用 Persona Effect 为 Persona 回复段生成动作。开启后使用单独选择的聊天 Provider，Persona Effect 动作路径停用；`per_speech_segment` 决定独立 Provider 是每条回复调用一次，还是对 Persona 每个非空 `segments[].speech` 分别调用并绑定到同索引的 TTS/输出段。分段模式保留 Persona 回复和 Core 的 TTS 生命周期。

`parallel` 在整回复模式中控制动作 Provider 与回复生成并行/串行；在分段模式中控制 Persona 结果到达后各段动作请求并发/串行。分段动作任务会在 Persona 结果钩子中启动，可与 Core 控制的 TTS 合成重叠。TTS 身份到达后 Adapter 按 `turn_id`、`persona_result_id` 和分段索引绑定动作；支持段级物化时，Core 最大并发 2 准备语音，每段只等待对应动作 Future，按序提交并 flush 原子 `output.segment`，第一段不等整批动作。普通整条消息 finalizer 保留原投递边界。段索引决定对应关系，Provider 的返回先后不决定播放顺序。

`history_turns` 控制附带的最近纯文本对话轮数（默认 6，范围 0–20）。动作 Provider 不接收图片、截图上下文说明或工具消息；主回复模型的图片输入不受影响。分段模式输入当前 `speech`、`actions`、`tendency`，并复用本轮已取得、允许模型读取的记忆摘要（最多 6 条，每条 240 字符），不额外检索记忆。Prompt 保留合法轴/等级和资源约束。另保留最多 2 个相关示例和最近 3 个执行动作，全部投影为当前输出契约的 input/output 结构；移除运行标识，跳过不兼容或超过 2400 字符的单条参考，不截断 JSON。当前 actions 优先于参考。分段模式另有 `max_concurrency`（默认 4，最大 8）和 `segment_timeout_seconds`（默认 5 秒，最大 60 秒；0 表示不限制单段请求），完整 Core 汇合仍受 30 秒上限约束。详细 WIRING 过程日志使用 DEBUG，分段生成摘要和最终投递保留 INFO，异常保留 WARN/ERROR。

Persona `segments[].speech` 是 TTS 文本分段，不是协议中的 speech cues。协议 slot 仍可承载可选 speech cues，但当前 Adapter 输出 `speech: absent`。详见[动作生成与 Persona 分段关联](../docs/01-架构与结构/07-动作生成与Persona分段关联.md)。

## 音频输入和取消

麦克风采集由 `input.audio_stream_start`、二进制 PCM16LE chunk 和 `input.audio_stream_end` 组成。后端用 `stream_id` 汇总、严格检查顺序，并根据 PTT 或 VAD 建立正式 Turn。持续收音的 `capture_turn_id` 只标识采集根，每段 VAD 语音使用 `<capture_turn_id>:vad:<n>` 子 Turn。

`control.interrupt` 只停止目标 Turn。连接断开时，Adapter 请求停止全部在飞 AG99 event，再独立清理 Turn、段、曲线请求和身份映射；晚到输出不会重新进入播放。

## AG99 Web 控制台

启用插件后，在 AG99 WebUI 的插件详情页打开 **AG99live 控制台**，可以编辑 Adapter 配置、Live2D 语义轴 Profile 和动作调参样例，并管理当前 Adapter 的对话历史。页面通过 AG99 插件视图 bridge 访问受认证的插件 API，不单独启动 Web 服务。

**对话历史** 支持只读查看、新建、显式载入和确认删除。只读查看不会切换当前会话；新建或载入会话会改变桌宠后续聊天的上下文。API 检查会话所属的 Adapter 平台及 Client UID，不允许跨实例操作；新建的空会话也会保留在列表中。此功能直接复用 AG99 会话服务，不依赖桌面 WebSocket 在线，也不占用第二条连接。页面按需读取历史，会话和消息每页最多渲染 100 项。

麦克风、全局快捷键和 Spout/ESP32 等本机功能仍由 AG99live 桌面运行时持有，Web 页面经桌面设置 broker 读写，不把本机配置存入 Adapter。Electron 还支持从 Web 修改鼠标凝视参数与托盘使用的 WebUI 基址；native runtime 以实际支持的设置项为准。实时动作预览仍保留本机入口；旧历史窗口保留到 Web 历史现场验收完成，不会自动同步 Web 会话选择，历史管理请优先使用 Web。

Electron 托盘和桌宠右键的 **打开 Web 控制面板** 会在默认浏览器打开本插件页面。默认 WebUI 基址为 `http://127.0.0.1:6185/`；使用其他地址或反向代理时，在桌面 **本机工具 > 本机设置** 或已连接的 Web 本机配置中设置。登录继续由 AG99 管理。

## 开发

在仓库根目录执行：

```powershell
python -m pip install -r astrbot_plugin_ag99live_adapter/requirements.txt
python scripts/check_protocol_schema_manifest.py
```

如果只拿到了已经复制到 AG99 插件目录的本目录，则在该插件目录执行：

```powershell
python -m pip install -r requirements.txt
```

协议检查只比较 schema manifest 与生成的 TypeScript 文件。完整验证仍需在真实 AG99、TTS、Electron 和 Live2D 环境中检查段顺序、音频、口型、动作和完成回执。

完整源码仓库中的深入说明见[文档中心](https://github.com/murphys7017/AG99live/blob/main/docs/README.md)。

## 发布版安装

桌面端安装包从 [AG99live GitHub Releases](https://github.com/murphys7017/AG99live/releases) 获取。Adapter 不随桌面安装包嵌入，需要将本目录复制到 AG99 插件目录，并在 AG99 使用的 Python 环境中执行：

```powershell
python -m pip install -r astrbot_plugin_ag99live_adapter/requirements.txt
```
