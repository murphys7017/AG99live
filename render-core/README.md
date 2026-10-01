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
- a DirectComposition swap chain can present a per-pixel transparent window;
- the Cubism Native Framework can start and initialize;
- the standalone `ag99_live2d_renderer_core` target owns the D3D11 device,
  transparent composition surface, swap chain, render target, and Present path;
- the same target owns the Cubism D3D11 renderer, model texture bindings,
  viewport matrix, and draw calls;
- the host owns the HWND, tray, frame loop, and model/runtime lifecycle, and
  borrows the surface's device and context while the model renderer is alive;
- a `model3.json` can be loaded from the command line;
- the referenced `.moc3` and PNG textures can be loaded;
- the model can be updated and rendered in the native frame loop.
- a tray icon can show, hide, or exit the runtime;
- the model window can be moved by dragging the canvas;
- the native host can connect to the Adapter at `ws://127.0.0.1:12396`;
- ambient motion selects randomly from the model's complete `Idle` group, as
  the existing WebSDK runtime does;
- all motion groups declared by `model3.json` are preloaded with the model's
  configured eye-blink and lip-sync effect IDs;
- canvas dragging now feeds the same normalized Angle/Body/EyeBall parameter
  adjustments used by the frontend;
- configured Physics, Pose, and Expression resources are loaded before the
  native frame loop;
- Physics input/output ownership is read from `physics3.json`, with semantic
  parameters protected from scaled Physics response writes;
- cached WAV audio from `output.segment` can be downloaded and played;
- configured eye-blink and lip-sync parameter IDs are attached to the loaded
  idle motions, matching the WebSDK motion setup.
- `system.model_sync` is consumed to cache the selected semantic axis profile;
- `engine.motion_intent.v4` axis levels are compiled into timed parameter
  tracks with relation-graph propagation, blend-in, hold, and blend-out;
- `engine.parameter_plan.v3` payloads are accepted directly and execute the
  frontend plan timing, keyframes, speech modulation, response dynamics, and
  optional expression resource;
- `motion_steps` are compiled into one multi-keyframe plan using each step's
  `duration_weight`, with omitted axes holding their previous target;
- completed parameter tracks release control and return to the model's idle
  motion.
- supported PCM16 WAV output now drives every configured LipSync parameter from
  a 50 Hz RMS envelope instead of a synthetic oscillator or fixed mouth ID.
- speech-driven modulation uses voiced hysteresis plus separate head/body and
  emphasis envelopes matching the frontend `SpeechSignalRuntime` constants;
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

The current demo uses a fixed-size D3D11 composition swap chain with
premultiplied alpha, so the model window background is transparent while the
Live2D textures remain visible. Window resizing and device-loss recovery are
not implemented. Spout output, microphone VAD/device selection, and production
audio amplitude analysis remain the next integration slices. The native runtime
is not a second settings application: the existing frontend remains the source
of configuration, while this host consumes the resulting runtime inputs.

The current Adapter still emits `engine.motion_intent.v4`; the direct parameter
plan path is prepared for the IPC bridge that will carry the frontend's
compiled plan to the native host.

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
