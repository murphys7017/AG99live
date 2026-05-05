# frontend

AG99live 的 Electron + Vue 客户端。

## 能力概览

- 桌宠窗口（Pet）
- 设置窗口
- 历史窗口
- Action Lab（动作计划预览与测试）
- 与 Adapter 的 V2 协议通信
- 前端 ModelEngine：本地编译 `engine.motion_intent.v2 -> engine.parameter_plan.v2`

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

- `turn_id + orchestration_id` 级文本 / 音频 / 动作软同步起播
- 文本、音频、动作先进入 pending 队列，再由 `useTurnPlaybackOrchestrator` 统一释放
- 音频 `playing` 仍会通知 `ModelEngine` 贴近音频起播动作；无音频和动作晚到场景有超时兜底
- 计划软衔接（soft handoff）
- 高频重复计划去重与重启节流
- 设置窗口支持 ModelEngine 表现倍率：全局强度倍率参与 v2 编译
- 动作实验室支持最近 5 次真实 v2 播放 plan 回放、主轴手动调参、保存调参样本
- Action Lab 参数动作原子池基于当前 semantic profile 生成 `engine.motion_intent.v2` 预览，不再生成旧 v1 plan
