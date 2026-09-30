# AG99live Native Render Core

This is the first native rendering slice for the desktop runtime.

The repository does not vendor the Live2D SDK or DirectXTK. Point CMake at the
SDK directory downloaded locally:

```powershell
cmake -S render-core -B render-core/build `
  -G "Visual Studio 17 2022" -A x64 `
  -DCUBISM_SDK_ROOT="C:\path\to\CubismSdkForNative-5-r.5"
cmake --build render-core/build --config Release
```

The current executable, `ag99-render-host`, verifies:

- a borderless desktop window can be created;
- a D3D11 hardware device and swap chain can be created;
- the Cubism Native Framework can start and initialize;
- the D3D11 renderer backend can receive the device;
- a `model3.json` can be loaded from the command line;
- the referenced `.moc3` and PNG textures can be loaded;
- the model can be updated and rendered in the native frame loop.
- a tray icon can show, hide, or exit the runtime;
- the model window can be moved by dragging the canvas;
- the native host can connect to the Adapter at `ws://127.0.0.1:12396`;
- the first `Idle/0` and `Talk/0` motion from the model can be played by the
  native motion manager;
- cached WAV audio from `output.segment` can be downloaded and played;
- playback drives the model's `ParamMouthOpenY` parameter.
- `system.model_sync` is consumed to cache the selected semantic axis profile;
- `engine.motion_intent.v4` axis levels are compiled into timed parameter
  tracks with relation-graph propagation, blend-in, hold, and blend-out;
- completed parameter tracks release control and return to the model's idle
  motion.
- text can be sent through the tray's `发送演示文本` command or `--text=...`;
- the tray can start and stop a manual 16 kHz mono microphone stream using
  the existing binary PCM protocol;

Run the host with the repository's Mk6 model:

```powershell
render-core\build\Release\ag99-render-host.exe `
  (Resolve-Path "astrbot_plugin_ag99live_adapter\live2ds\Mk6_1.0\Mk6.model3.json") `
  --text="请说一句原生渲染演示"
```

The tray menu can send the built-in demo text again without restarting the
host. `开始麦克风` and `停止麦克风` exercise the native capture path. This
first voice slice is deliberately manual: VAD, device selection, and input
settings remain outside the native core for now.

The current demo still uses the existing D3D11 HWND swap chain, so the
background is opaque. True per-pixel transparent composition, Spout output,
microphone VAD/device selection, and production audio amplitude analysis remain
the next integration slices. The native runtime is not a second settings
application: the existing frontend remains the source of configuration, while
this host consumes the resulting runtime inputs.

## Production boundary

The native host is intended to replace the frontend's rendering and playback
runtime, not its settings application. The existing frontend remains the
control plane for connection, audio, presentation, motion, and model settings.
The native host remains the runtime plane for protocol consumption, motion
execution, audio playback/lip-sync, and Live2D rendering.

The Adapter currently permits one WebSocket client. Therefore the direct
Adapter connection used by this demo is not the final coexistence architecture:
the production host must be the sole Adapter client, while the existing
frontend sends settings and control commands to it through a local IPC bridge.
Adding a second independent Adapter connection would make the frontend and
native runtime compete for the same session.
