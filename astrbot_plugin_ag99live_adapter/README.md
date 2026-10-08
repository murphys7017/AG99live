# AG99live Adapter

AG99 插件 `astrbot_plugin_ag99live_adapter` 将 AG99 的对话、TTS 和 Persona Effect 接入 AG99live 桌面端。当前版本为 **1.1.0**，协议版本以 `protocol/schema_manifest.json` 为准。本版本与 AG99live 桌面端 `0.1.0` 安装包配套。

## 职责

- 接收文本、流式麦克风、图片和平台事件输入，并提交到 AG99 的正常对话流程。
- 收集一条逻辑消息的文本、TTS、动作、speech cues 和媒体，提交原子 `output.segment` 消息，其 Payload Schema 为 `output.segment.v5`。
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

增强 Persona Effect 是主路径。缺少 Persona 注入能力的官方 AstrBot 可以使用 `<@anim>` 兼容传输；兼容入口不修复增强路径失败，也不改变 V4 动作输入契约。

动作输入选择 `axis_levels`、稀疏 `motion_steps` 或 `motion_resource_id` 之一。未知轴、非法等级、空 step、形态冲突和无效资源会明确失败；Adapter 不补轴、不改名、不生成 neutral pose。

### 实验性独立动作生成

`independent_motion.enabled` 默认关闭。启用后，Adapter 使用单独选择的聊天 Provider 生成动作意图，主对话模型不再生成这份动作参数；关闭后继续走 Persona Effect 主路径。`history_turns` 控制附带的最近文本对话轮数（默认 6，范围 0–20），当前轮实际收到的图片会单独传给动作 Provider；要让模型理解照片，请选择支持视觉输入的 Provider。不会把缓存复用的旧桌面截图或历史图片当成本轮图片发送。

`parallel` 开启时，动作请求与当前可见回复的 Persona 表达生成并行启动，等两路结果都可用后再进入动作调度；此时动作模型看不到尚未生成的回复文本。关闭时则等回复文本生成后才调用动作 Provider，并把该回复作为动作判断上下文。即时回复和最终回复分别匹配各自的动作结果；两种模式都会在动作结果就绪后再进入当前输出调度。

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
