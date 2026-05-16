# 文档索引

`docs/` 只保留当前有效的结构、协议和设计文档。

阶段性计划、进度记录、旧方案和历史判断统一放在 `docs/archive/`，不作为当前工作入口。

## 当前工作入口

建议按下面顺序阅读：

1. `architecture/项目结构与模块职责总览.md`
2. `api/protocol.md`
3. `ModelEngine驱动系统边界与分层设计.md`

如果要看更细的前端结构，再继续读：

- `architecture/前端系统模块架构说明.md`
- `architecture/当前前后端动作链路结构说明.md`
- `architecture/文本语音动作同步播放编排设计.md`

## 当前有效文档

### 总览与结构

| 文件 | 作用 |
| --- | --- |
| `architecture/项目结构与模块职责总览.md` | 仓库结构、模块职责和维护边界总览 |
| `architecture/前端系统模块架构说明.md` | 前端一级模块、依赖方向和当前边界 |
| `architecture/当前前后端动作链路结构说明.md` | 文本、音频、动作主链路的当前结构 |
| `architecture/文本语音动作同步播放编排设计.md` | Turn 内文本、音频、动作的同步起播策略 |

### 协议与引擎

| 文件 | 作用 |
| --- | --- |
| `api/protocol.md` | 当前唯一有效的 WebSocket 协议契约 |
| `ModelEngine驱动系统边界与分层设计.md` | 前端动作引擎的边界、分层和扩展设计 |

### 其他

| 文件 | 作用 |
| --- | --- |
| `archive/README.md` | 历史文档索引 |
| `design/engineering_cybernetics_alignment.md` | AI 治理与设计理念说明 |
| `runtime/agent_execution_protocol.md` | AI 运行协议 |
| `runtime/release_package.md` | 打包与发布说明 |

## 维护规则

- 当前文档只写现在真实成立的结构和边界。
- 新的阶段计划、施工记录、审阅底稿默认放到 `docs/archive/`。
- 当前文档里不保留“以前怎么样、现在改成怎么样”的叙述。
- 如果一个文档不再适合作为当前入口，就移到 `docs/archive/`。
