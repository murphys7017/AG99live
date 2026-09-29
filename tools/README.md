# 仓库工具

从仓库根目录运行：

```powershell
python tools/validate_runtime.py
```

该脚本检查 AI 运行指引和状态文件是否具备最小必填结构。它不检查前端构建、Adapter 协议或桌面播放。

常用的工程检查：

```powershell
python scripts/check_protocol_schema_manifest.py

cd frontend
npm run typecheck
```

协议检查验证 schema manifest 与生成的 TypeScript 文件一致；类型检查覆盖前端 TypeScript 边界。真实 AstrBot、TTS、Electron、Live2D 和 OBS 行为仍需手动运行验收。
