# AG99 Runtime Core

阶段一的 C++ 协议核心。当前包含：

- `v2` JSON 信封解析与构造
- `input.text`、音频流 start/end、`control.playback_finished` 和
  `control.audio_credit` 出站消息构造
- Native 连接的 `system.desktop_runtime_settings` 能力声明构造
- `output.segment.v6` 严格解析
- `output.segment_motion` 同身份后到动作解析
- OLV `output.*_stream_*` 文本/音频/动作事件的身份、序号和格式解析
- OLV type=2 下行 PCM 帧的 metadata、采样偏移和容量边界解析
- OLV 增量流按 turn、段、资源和序号进行生命周期、容量、跨段音频顺序校验
- `engine.motion_intent.v4` 基本协议边界校验
- `AG99` 二进制 PCM16LE 音频帧解析与构造
- `output.segment` 按 `turn_id + sequence` 重排、去重和冲突拒绝
- `RuntimeProtocolSession` 接收入口：文本/二进制帧解析、重排和错误回调
- Windows 原生 WinHTTP WebSocket 客户端
- 协议回放 CLI 与 CTest smoke test

协议版本和各子 Schema 的唯一来源是
`astrbot_plugin_ag99live_adapter/protocol/schema_manifest.json`。CMake 配置阶段
会从该 manifest 生成 Native 头文件，`protocol.hpp` 不再手工复制版本号；如果
manifest 变更，重新配置构建目录即可同步 C++ 侧。

## 构建

需要 CMake 3.25+。配置时会通过 CMake `FetchContent` 获取
`nlohmann/json` 3.11.3。

```powershell
cmake -S runtime-core -B runtime-core/build -DAG99_RUNTIME_BUILD_TESTS=ON
cmake --build runtime-core/build --config Release
ctest --test-dir runtime-core/build -C Release --output-on-failure
```

## 回放

无参数时回放内置样本：

```powershell
runtime-core/build/Release/ag99-runtime-replay.exe
```

也可以传入 JSON Lines 文件，每行一条协议信封：

```powershell
runtime-core/build/Release/ag99-runtime-replay.exe .\fixtures\segments.jsonl
```

当前阶段的 OLV 支持已经包含协议接收和增量流状态校验：通过校验的事件和
type=2 PCM 帧会经独立回调交给上层，但还没有接入有界播放 worker、audio
credit/backpressure、Timeline 播放或 Live2D 渲染。旧的完整段和麦克风 type=1
路径不受影响。Native 连接会明确声明 `audio_credit_schema`，同时将
`persona_segment_stream_enabled` 保持为 `false`，直到播放 worker 完成。
