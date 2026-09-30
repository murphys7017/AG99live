# AG99 Runtime Core

阶段一的 C++ 协议核心。当前包含：

- `v2` JSON 信封解析与构造
- `input.text`、音频流 start/end 和 `control.playback_finished` 出站消息构造
- `output.segment.v5` 严格解析
- `engine.motion_intent.v4` 基本协议边界校验
- `AG99` 二进制 PCM16LE 音频帧解析与构造
- `output.segment` 按 `turn_id + sequence` 重排、去重和冲突拒绝
- `RuntimeProtocolSession` 接收入口：文本/二进制帧解析、重排和错误回调
- Windows 原生 WinHTTP WebSocket 客户端
- 协议回放 CLI 与 CTest smoke test

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

当前阶段不包含音频设备、TTS 下载、Timeline 播放和 Live2D 渲染。
