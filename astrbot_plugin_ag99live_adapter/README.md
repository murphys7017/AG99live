# AG99live Adapter

AstrBot 插件 `astrbot_plugin_ag99live_adapter` 将 AstrBot 的对话、TTS 和 Persona Effect 接入 AG99live 桌面端。当前版本为 **1.1.0**，协议版本以 `protocol/schema_manifest.json` 为准。

## 职责

- 接收文本、流式麦克风、图片和平台事件输入，并提交到 AstrBot 的正常对话流程。
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

端口由插件根配置的 `port` 和 `http_port` 设置。其他常用根配置包括 `speaker_name` 和 `auto_start_mic`；运行资料归入 `general`、`live2d_input`、`performance_curve` 与 `vad`。请使用 AstrBot 当前插件 Schema 生成或编辑配置，旧平级路径不再读取。

## 动作路径

```text
AstrBot Persona
  -> ag99live.motion
  -> Adapter 严格校验
  -> engine.motion_intent.v4
  -> output.segment（schema: output.segment.v5）
  -> 前端 ModelEngine
  -> engine.parameter_plan.v3 或受控资源执行
```

增强 Persona Effect 是主路径。缺少 Persona 注入能力的官方 AstrBot 可以使用 `<@anim>` 兼容传输；兼容入口不修复增强路径失败，也不改变 V4 动作输入契约。

动作输入选择 `axis_levels`、稀疏 `motion_steps` 或 `motion_resource_id` 之一。未知轴、非法等级、空 step、形态冲突和无效资源会明确失败；Adapter 不补轴、不改名、不生成 neutral pose。

## 音频输入和取消

麦克风采集由 `input.audio_stream_start`、二进制 PCM16LE chunk 和 `input.audio_stream_end` 组成。后端用 `stream_id` 汇总、严格检查顺序，并根据 PTT 或 VAD 建立正式 Turn。持续收音的 `capture_turn_id` 只标识采集根，每段 VAD 语音使用 `<capture_turn_id>:vad:<n>` 子 Turn。

`control.interrupt` 只停止目标 Turn。连接断开时，Adapter 请求停止全部在飞 AstrBot event，再独立清理 Turn、段、曲线请求和身份映射；晚到输出不会重新进入播放。

## 开发

在仓库根目录执行：

```powershell
python -m pip install -r astrbot_plugin_ag99live_adapter/requirements.txt
python scripts/check_protocol_schema_manifest.py
```

如果只拿到了已经复制到 AstrBot 插件目录的本目录，则在该插件目录执行：

```powershell
python -m pip install -r requirements.txt
```

协议检查只比较 schema manifest 与生成的 TypeScript 文件。完整验证仍需在真实 AstrBot、TTS、Electron 和 Live2D 环境中检查段顺序、音频、口型、动作和完成回执。

完整源码仓库中的深入说明见[文档中心](https://github.com/murphys7017/AG99live/blob/main/docs/README.md)。
