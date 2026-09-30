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
- cached WAV audio from `output.segment` can be downloaded and played;
- playback drives the model's `ParamMouthOpenY` parameter.

Run the host with the repository's Mk6 model:

```powershell
render-core\build\Release\ag99-render-host.exe `
  (Resolve-Path "astrbot_plugin_ag99live_adapter\live2ds\Mk6_1.0\Mk6.model3.json")
```

The current demo still uses the existing D3D11 HWND swap chain, so the
background is opaque. True per-pixel transparent composition, Spout output,
full motion-plan playback, microphone capture, and production audio amplitude
analysis remain the next integration slices. The native runtime is not a
second settings application: the existing frontend remains the source of
configuration, while this host consumes the resulting runtime inputs.
