# frontend

AG99live 的 Electron + Vue 客户端。

## 能力概览

- 桌宠窗口（Pet）
- 设置窗口
- 历史窗口
- Action Lab（动作计划预览与测试）
- 与 Adapter 的 V2 协议通信
- 前端 ModelEngine：本地编译 `engine.motion_intent.v1 -> engine.parameter_plan.v1`

## 开发命令

```powershell
cd frontend
npm install
npm run dev
```

常用：

- `npm run typecheck`
- `npm run build`
- `npm run build:web`

## 当前动作播放特性

- `turn_id` 级动作/音频同步
- 音频 `playing` 触发动作起播，无音频时超时兜底
- 计划软衔接（soft handoff）
- 高频重复计划去重与重启节流
- 设置窗口支持 ModelEngine 表现倍率：全局强度与 12 轴单独倍率
