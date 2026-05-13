# Documentation

This directory contains human-facing project documentation.

## Current Docs

| File | Purpose |
|---|---|
| `V2当前实现状态与下一步.md` | V2 当前实现快照、已完成项、剩余工作 |
| `项目结构优化路线图.md` | 下一阶段结构优化入口 |
| `后端主导数据边界与执行计划.md` | 长期数据归属边界和结构收口方向 |
| `api/protocol.md` | 当前唯一有效的 WebSocket 协议契约 |

## Architecture

| File | Purpose |
|---|---|
| `architecture/当前前后端动作链路结构说明.md` | 文本 / 音频 / 动作链路的结构手册 |
| `architecture/前端系统模块架构说明.md` | 前端模块边界、依赖方向和收口优先级 |
| `architecture/文本语音动作同步播放编排设计.md` | 文本 / 音频 / 动作软同步起播方案 |

## Subdirectories

- `architecture/` - system architecture docs
- `api/` - protocol contract (`protocol.md`)
- `design/` - design rationale (VEC governance alignment)
- `runtime/` - agent execution protocol
- `archive/` - historical design documents
- `images/` - project screenshots and diagrams

## Reading Guide

- Quick overview: root `README.md`, then `V2当前实现状态与下一步.md`
- Structure optimization: `项目结构优化路线图.md`
- Frontend architecture: `architecture/前端系统模块架构说明.md`
- Playback pipeline: `architecture/当前前后端动作链路结构说明.md` + `architecture/文本语音动作同步播放编排设计.md`
- Data ownership: `后端主导数据边界与执行计划.md`
- Protocol contract: `api/protocol.md`
- Historical context: `archive/`
