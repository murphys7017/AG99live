<div align="center">

# AG99live

**一个让大模型决定“说什么”，也决定“如何表现”的本地桌面 Live2D AI 助手。**

不是预设表情播放器，而是一套面向对话表演的语义动作系统。

[快速开始](#快速开始) · [核心理念](#核心理念) · [技术文档](./docs/README.md)

</div>

## 项目是什么

AG99live 是一个运行在 Windows 桌面上的 AstrBot + Electron + Live2D AI 角色系统。

它把一次对话转换成一段完整的角色表现：

```text
用户输入
  -> AstrBot / 主模型生成回复文本与 Persona Effect
  -> Adapter 校验并整理语义动作意图
  -> 前端 ModelEngine 编译 Live2D 参数计划
  -> PlaybackTimeline 统一协调音频、动作和口型
  -> Live2D 角色完成这一轮表演
```

角色的动作不是简单地播放 `motion3.json` 或 `exp3.json`。当前主链路由模型生成语义轴目标，例如：

```json
{
  "intent_tags": ["疑惑", "轻微调侃"],
  "axis_levels": {
    "head_yaw": 3,
    "body_yaw": -2,
    "brow_bias": 3
  }
}
```

这些九级语义强度还不是最终的 Live2D 参数。它们会经过当前模型的语义轴档案、确定性区间采样、轴关系图和播放时序，最终变成角色在这一轮对话中的动作表现。

## 核心理念

### 对话语义驱动动作

主模型在生成回复文本的同时，通过 `ag99live.motion` Persona Effect 表达本轮动作意图。动作可以覆盖头部、身体、视线、眼睛、眉毛和嘴角等语义轴。

模型不需要知道具体的 Live2D 文件路径，也不直接选择底层播放文件。它只需要理解角色应该表现出什么方向、姿态和语气。

### ModelEngine 负责把意图变成参数

前端 ModelEngine 是动作编译器，而不是简单的播放器。它负责：

- 校验动作意图和当前模型 profile。
- 将语义轴映射到真实模型参数。
- 应用强度、轴关系、说话姿态和 timing 等可挂载 stage。
- 生成 `engine.parameter_plan.v2`。
- 将编译诊断和动作来源交给播放与实验工具。

这让同一种“疑惑”可以根据不同 Live2D 模型的参数能力，得到不同但合理的表现。

### 音频、动作和口型共享统一时钟

一段回复由 `turn_id + message_id` 标识。文本、音频、动作和口型属于同一个播放 segment，由 `PlaybackTimeline` 统一协调：

- 音频使用真实 `HTMLAudioElement` 播放时钟。
- 动作在音频时序上启动，并由 ModelEngine 生成参数计划。
- 口型从同一音频播放段采样。
- 每个 sink 都有明确的 started、completed、failed 和 interrupted 终态。

因此，动作不是收到消息就立刻独立播放，而是进入同一段对话表现的时间线上。

### 模型资源受语义动作引擎统一管理

项目会扫描 Live2D 的 motion、expression 和参数资源，用来分析：

- 模型真实使用了哪些参数。
- 哪些参数适合成为动作主轴或表情辅轴。
- 头部、身体、视线和面部细节之间如何组合。
- 哪些姿态可以作为受控的语义参考。

当前自动动作主链路仍以语义轴为基础，不让模型输出 `motion3`、`exp3`、文件路径或旧式动作选择器。被模型 catalog 显式暴露的资源可以通过 typed resource ID 选择：expression 与无冲突参数计划叠加，完整 motion 替代参数计划；两者都必须经过 ModelEngine，并共享当前 segment 的 Timeline motion sink。

## 主要能力

### 实时对话桌宠

支持文字输入和麦克风输入。Electron 桌面端负责窗口、麦克风、音频播放和 Live2D 展示，AstrBot 插件负责对话接入、turn 生命周期和前后端协议桥接。

### 语音与口型表现

支持 TTS 音频输出，并通过统一播放 Timeline 协调音频起播、动作延迟和 Live2D 口型采样。音频数据通常通过插件侧静态资源 URL 提供给前端播放。

### 语义动作引擎

动作链路的主协议是：

```text
ag99live.motion Persona Effect
  -> engine.motion_intent.v4 (axis_levels -4..4)
  -> ModelEngine
  -> engine.parameter_plan.v2 / typed motion resource
  -> PlaybackTimeline motion sink
  -> Live2D runtime
```

动作引擎支持头身动作、视线、眼睛、表情辅轴、说话姿态和模型级参数映射。引擎扩展通过 compiler stage registry 挂载，而不是继续向单个播放器文件堆叠逻辑。

### 动作实验室

动作实验室用于观察和调校模型生成的动作。SQLite raw event schema v2 会关联保存原始九级输出、锚点解析值、关系图约束值、最终参数计划、profile hash、transform version、run ID 和播放终态，为后续人工筛选与训练提供可归因数据。

### 语义轴档案

每个 Live2D 模型通过 `soft_range / strong_range / extreme_range` 独立校准九级动作。普通主要姿态从三级开始以保证可见性，四级使用独立夸张范围；确定性采样让同一 segment 可复现，同时保留不同回复之间的细微变化。

每个 Live2D 模型可以拥有自己的 `SemanticAxisProfile`，描述语义轴到模型参数的映射、范围、中性值、主轴/辅轴角色和关系约束。

这使动作系统不依赖某一个固定模型，也不把某个模型的参数名直接暴露为对话层协议。

### Windows 操作委托

对于打开软件、查看桌面、操作浏览器等任务，AG99live 可以把任务委托给配置好的 Codex app-server / Computer Use 或 OpenCode 执行器。

主模型只描述目标、约束和成功标准，不直接输出坐标、UIA selector 或 shell 操作步骤。

## 一次互动如何完成

```text
用户输入文字或语音
  -> 前端创建 turn
  -> AstrBot 生成助手文本
  -> 主模型通过 Persona Effect 生成动作意图
  -> Adapter 从 view.effect_calls 读取动作
  -> 后端按 turn_id + message_id 广播文本、音频和动作
  -> 前端 orchestrator 聚合同一 segment
  -> PlaybackTimeline 等待并释放播放任务
  -> 音频建立真实时钟
  -> ModelEngine 启动动作计划
  -> Live2D runtime 同步处理参数、物理和口型
  -> audio / motion / lip-sync 分别报告终态
  -> turn 完成
```

`<@anim>` 只保留为官方 AstrBot 兼容路径：只有当前运行环境无法注入 Persona Effect 时才使用它。它不是 `ag99live.motion` 无效后的 fallback，也不是当前主链路。

## 项目结构

```text
AG99live/
├─ frontend/                          # Electron + Vue 桌面客户端
│  ├─ src/model-engine/                # 语义动作编译器和 stage registry
│  ├─ src/playback-timeline/           # 音频、动作、口型统一播放时钟
│  ├─ src/live2d/                      # Live2D WebSDK 和模型运行时
│  └─ src/turn-playback/               # turn / segment 播放编排
├─ astrbot_plugin_ag99live_adapter/   # AstrBot 插件后端和协议适配层
│  ├─ middleware/                      # Persona Effect、Prompt、result contributor
│  ├─ motion/                          # 动作意图、profile 和资源分析
│  ├─ runtime/                         # turn、消息、媒体和运行状态
│  ├─ live2d/                          # 模型扫描、缓存和能力分析
│  └─ protocol/                        # WebSocket 消息契约
├─ docs/                               # 架构、协议和动作系统设计
└─ tools/                              # 开发与运行验证工具
```

## 快速开始

### 启动前端开发环境

```powershell
cd frontend
npm install
npm run dev
```

### 部署 AstrBot 适配器

将 `astrbot_plugin_ag99live_adapter/` 目录放入 AstrBot 插件目录：

```powershell
Copy-Item -Recurse .\astrbot_plugin_ag99live_adapter "C:\path\to\AstrBot\data\plugins\"
```

然后在 AstrBot 中启用该插件。仓库内的本地部署脚本仅用于个人联调，不作为正式安装器维护。

## 技术文档

建议从 [docs/README.md](./docs/README.md) 开始。重点入口：

- [项目总览与模块职责](./docs/01-架构与结构/01-项目总览与模块职责.md)
- [WebSocket 协议契约](./docs/01-架构与结构/02-WebSocket协议契约.md)
- [前后端动作链路结构](./docs/01-架构与结构/03-前后端动作链路结构.md)
- [播放同步编排设计](./docs/01-架构与结构/04-播放同步编排设计.md)
- [ModelEngine 边界与分层设计](./docs/02-设计文档/01-ModelEngine边界与分层设计.md)
- [动作意图标签化与资源派生设计](./docs/02-设计文档/10-动作意图标签化与资源派生设计.md)
- [动作参数处理与轴关系图](./docs/02-设计文档/13-动作参数处理与轴关系图.md)
- [统一时钟引擎设计](./docs/02-设计文档/12-统一时钟引擎设计.md)

## 开发方向

AG99live 是一个持续开发的本地桌面角色系统，重点不是固定动作播放器，而是让模型生成的语言和动作共同构成可执行的 Live2D 表演：

> 如何让一个对话模型的语言、动作、语音和口型共同组成一段可解释、可调试、可持续优化的 Live2D 表演。

项目坚持单一主链路、明确所有权和错误可见：主模型表达语义动作，ModelEngine 负责参数计算，PlaybackTimeline 负责同步，Live2D WebSDK 负责逐帧执行。旧协议、旧播放链和失效文档不会作为兼容负担继续保留。
