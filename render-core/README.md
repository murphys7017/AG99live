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
- cached PCM WAV audio from `output.segment` can be downloaded and played from
  memory through the native `waveOut` path, without a temporary audio file;
- OLV type=2 PCM frames can be admitted through a bounded single audio worker,
  written to bounded `waveOut` blocks, and acknowledged with cumulative
  `control.audio_credit` messages;
- configured eye-blink and lip-sync parameter IDs are attached to the loaded
  idle motions, matching the WebSDK motion setup.
- `system.model_sync` is consumed to cache the selected semantic axis profile;
- `output.segment_motion` can complete a pending motion slot on the original
  audio clock without replaying the audio;
- `engine.motion_intent.v4` continuous semantic axis values are compiled into
  timed parameter tracks with relation-graph propagation, blend-in, hold, and
  blend-out;
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
- `output.pre_action` can start and cancel a bounded one-step reaction without
  entering the conversation playback ledger;
- Native semantic motion applies the same eight-axis budget and repeated
  direction attenuation used by the TypeScript performance governor;
- the configured Bilibili live room can be read from the shared Web settings,
  receive public-room danmaku, and submit bounded batches back as Adapter text;
- resizing the model window resizes the D3D11 composition surface and model
  projection together.
- `system.desktop_observation_request` captures a bounded virtual-desktop JPEG
  and returns it to the Adapter; comparison and policy remain outside Native.

Run the host with the repository's Mk6 model:

```powershell
render-core\build\Release\ag99-render-host.exe `
  (Resolve-Path "astrbot_plugin_ag99live_adapter\live2ds\Mk6_1.0\Mk6.model3.json") `
  --text="请说一句原生渲染演示"
```

The tray menu can send the built-in demo text again without restarting the
host. `开始麦克风` and `停止麦克风` exercise the native capture path. This
voice slice is deliberately manual: VAD remains outside the native core, while
device selection and capture lifecycle are owned by `NativeInputRuntime` and
the existing Adapter desktop-settings path.

## Native performance sample

After building the Release host, collect a repeatable local baseline with:

```powershell
.\render-core\scripts\measure-native.ps1
```

The script warms the host before sampling and reports elapsed time, process CPU
time as a percentage of one logical core, working set, private memory, and thread
count. It only stops the process that it started. Compare the same model,
window size, warmup, and sample duration across Native commits; these numbers
are local diagnostics, not a substitute for acceptance on the target machine.

The current demo uses a D3D11 composition swap chain with premultiplied alpha,
so the model window background is transparent while the Live2D textures remain
visible. Window resizing is supported; device-loss recovery is not implemented.
Microphone VAD remains outside the native core. Spout output is implemented as an optional
backbuffer readback plus the repository's `AG99liveSpoutSender.exe`; it still
requires paired Spout/OBS acceptance on the target machine. The native runtime
is not a second settings application: the existing frontend remains the source
of configuration, while this host consumes the resulting runtime inputs.

The current Adapter still emits `engine.motion_intent.v4`. The native host also
accepts `engine.parameter_plan.v3` segments directly. The Native motion compiler
now enforces the same bounded-axis and repeated-direction rules as the TS
performance governor; phrase-level schedule and continuity diagnostics remain
attached to the parameter-plan path.

The Native OLV path owns bounded audio admission, device sink teardown, the
existing 50 Hz RMS/lip-sync signal, incremental text preview, and final motion
release through the same Native ModelEngine queue used by complete segments.
Motion updates are coalesced to the latest validated payload and released after
the corresponding audio stream drains, matching the frontend's incremental
timeline contract. A completed OLV turn sends `control.playback_finished` only
after text, PCM, and motion have reached terminal state. Sink, queue, and
credit-send failures interrupt the affected Turn and clear the pending
incremental jobs instead of leaving an accepted protocol stream hanging. Audio
end status, reason, and total sample count are checked before the worker closes
a stream. The capability is opt-in through `AG99_NATIVE_OLV=1`; it remains off
by default until paired Adapter/Core/TTS, real audio-device, and visible Live2D
acceptance are complete. Motion arriving more than 1.8 seconds after the PCM
tail is rejected with a terminal reason matching the frontend runtime. When a
later segment replaces an earlier Native motion plan, that replacement is
treated as a normal terminal handoff instead of failing the OLV turn.

The native frame path samples its monotonic clock once per frame and reuses that
timestamp for audio, parameter mixing, and motion timing. Parameter contribution
source labels are non-owning views, so the high-frequency mixer does not build
temporary prefixed strings for every frame. These are local implementation
optimizations; benchmark numbers still need to come from paired native runs.

## Web desktop settings

The host handles `system.desktop_settings_query` from the existing AG99 Web
configuration broker and replies with `system.desktop_settings_result` on its
current Adapter connection. No additional Web service or TS desktop bridge is
required for this configuration path.

Currently supported:

- `speech_volume`: list/set, default `1`, range `0` to `1`, UI step `0.01`.
  Changes update the active WAV/OLV waveOut device and all subsequent playback.
- `microphone_device`: list/set. Native enumerates the available WinMM capture
  devices and restarts an active capture stream after a successful change;
  `default` uses the Windows mapper.
- `adapter_address`: list/set, default `ws://127.0.0.1:12396`. The value is
  used by the Native reconnect path; changing it does not interrupt the
  current connection until the user selects `重连 Adapter` from the tray.
- `cursor_gaze_enabled`: list/set, default `true`.
- `cursor_gaze_poll_interval_ms`: list/set, default `100`, range `50` to `1000`.
- `cursor_gaze_dwell_ms`: list/set, default `450`, range `100` to `2000`.
- `cursor_gaze_stationary_distance_px`: list/set, default `14`, range `1` to `100`.
- `spout_enabled`: list/set, default `false`. Native reads the rendered RGBA
  backbuffer and streams bounded frames to `AG99liveSpoutSender.exe` on a
  background worker. The sender is searched beside the executable and under
  `frontend/resources/spout` in development checkouts.
- `live2d_physics_response_scale`: list/set, default `1`, range `0.5` to `2`,
  UI step `0.05`. Values are rounded to two decimal places, matching the TS
  presentation settings normalizer; they are not snapped to the UI step.
- `live2d_ambient_motion_enabled`: list/set, default `true`. Disabling it
  prevents a new random `Idle` motion from starting after the current motion
  finishes; queued conversation motions remain independent.
- `model_view_scale`: list/set, default `1`, range `0.8` to `2`, UI step `0.05`.
- `model_view_offset_x` and `model_view_offset_y`: list/set, default `0`, range
  `-1.5` to `1.5`, UI step `0.05`. Offsets use the same logical model-space
  coordinates as the TS desktop.
- `motion_engine_intensity_scale`: list/set, default `1.35`, range `0.5` to
  `2.5`, UI step `0.05`. Native applies the scale only to expressive semantic
  motion values before relation-graph range constraints.
- `bilibili_live_enabled`, `bilibili_live_room_id`,
  `bilibili_live_cookie`, and `bilibili_live_response_interval`: list/set from
  the same Adapter Web settings. Native uses the configured room to receive
  public danmaku and submits bounded batches through the current Adapter
  connection. Cookie values are masked when listed.

Accepted changes are queued under the model runtime mutex and applied by the
render thread before the next Physics update. They remain in memory for this
host session, including reconnects, but are not persisted across host restarts.
Invalid values return `desktop_setting_value_invalid`; finite out-of-range
values return `desktop_setting_value_out_of_range`. All other setting keys
return `desktop_setting_unsupported`, not a successful placeholder value.

## Production boundary

The TS desktop remains the stable reference implementation for new features
and testing. The C++ desktop is a separate high-performance implementation of
the same protocol and runtime behavior. Configuration continues to use the
existing Web pages; Native migrates supported settings incrementally.

There is no Native settings window. The Adapter Web page is the only settings
entry point; Native only consumes and applies the canonical runtime snapshot.
History, Action Lab, Profile Editor, auxiliary Electron windows and ESP32
display remain outside the Native target. Native parity targets the model
window and runtime capabilities needed for conversation, audio, motion,
screenshot capture, Bilibili input and Spout output.

The Adapter currently permits one WebSocket client. The user manually chooses
which desktop to run: TS or C++. Neither client requires the other to run.
There is no launch mutex, automatic client switching, or concurrent-desktop
coordination layer. Close the active desktop before testing the other against
the same Adapter instance.
