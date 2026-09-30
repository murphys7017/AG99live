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
- the frame loop can clear and present without a browser renderer.

Model loading, texture binding, parameter updates, motions, audio/lip-sync,
and the runtime protocol are intentionally not wired into this first slice.
