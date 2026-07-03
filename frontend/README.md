# frontend

AG99live 的 Electron + Vue 客户端。

## 能力概览

- 桌宠窗口（Pet）
- 设置窗口
- 历史窗口
- Action Lab（动作计划预览与测试）
- 与 Adapter 的 V2 协议通信
- 前端 ModelEngine：本地编译 `engine.motion_intent.v3 -> engine.parameter_plan.v2`，不再接受旧版 `engine.motion_intent.v2`

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

- `TurnPlaybackSession` 作为前端播放轮次真源
- 基于 `turn_id + message_id` 的文本 / 音频 / 动作软同步起播
- 协议事件先写入 session，再由 `useTurnPlaybackOrchestrator` 统一释放
- 音频 `playing` 仍会通知 `ModelEngine` 贴近音频起播动作；无音频和动作晚到场景有超时兜底
- `synth_finished` 后同一 segment 的晚到音频可在最终结算前补齐；同段重复音频、已释放或已终态音频不会重复播放
- `output.audio.audio_url` 会按当前适配器连接重写 host，再交给浏览器音频和 lip sync fetch；如果浏览器无声，应同时检查 WebSocket 和 Adapter HTTP 静态资源可达性
- 本地播放完成与后端 `turn_finished` 已分离：先 `playback_finished`，再等后端收口
- 计划软衔接（soft handoff）
- 高频重复计划去重与重启节流
- 设置窗口支持 ModelEngine 表现倍率：全局强度倍率参与语义 intent 编译
- 动作实验室支持最近 5 次真实语义播放 plan 回放、主轴手动调参、保存调参样本
- Action Lab 参数动作原子池基于当前 semantic profile 生成 `engine.motion_intent.v3` 预览
- 自动动作链路不直接播放 motion3 / exp3 / catalog motion；这些旧资源只作为分析、实验室、预览或 fallback pose 抽取来源
