# V2 Live2D 扫描设计草案

快照日期：2026-04-21

## 核心目标

扫描器负责把模型目录转成“前端动作引擎可消费的数据”，不负责实时动作决策。

## 四步流程（当前版本）

### 第一步：定位与发现（已完成）

- 扫描模型根目录
- 发现 `model3.json`、`cdi3.json`、`physics3.json`、`exp3.json`、`motion3.json`
- 解析基础资源索引与可访问 URL

### 第二步：参数读取与标准通道归类（已完成）

- 提取原生参数信息
- 对齐到标准通道（头、身、视线、眼、眉、嘴、呼吸等）
- 产出 `parameter_scan` 和标准通道映射

### 第三步：表情读取与约束归类（已完成）

- 解析 expression 对参数的影响
- 区分基础表达与特殊状态信息
- 与参数层合并为可消费约束数据

### 第四步：motion 拆分与基础动作库构建（已完成首版）

- 拆分 motion 组件，提取可复用动作原子候选
- 先宽收集（rule seed），再严筛选（可选 LLM filter）
- 产出 `base_action_library`（通道/家族/原子/分析摘要）

## 当前输出结构

每个模型输出包含：

- `resource_scan`
- `parameter_scan`
- `expression_scan`
- `base_action_library`
- `motion_resource_pool`
- `constraints`
- `engine_hints`

## 宽进严出策略

### 宽进（已实现）

- 从 motion 组件尽可能提取候选动作原子
- 允许多通道候选进入初筛池

### 严出（已实现）

- 规则筛选：按通道、极性、trait、得分做首轮收敛
- LLM 筛选：可选二次严格筛选，保留通用基础动作
- fallback：LLM 不可用或超时时回退到规则结果

## 已落地配置

- `enable_action_llm_filter`
- `action_llm_filter_timeout_seconds`
- `action_llm_filter_min_selected_channels`
- `action_llm_filter_max_atoms_per_channel`

## 与前端协作状态

- 扫描结果已通过 `system.model_sync` 下发
- 前端 Action Lab 已可读取动作库并生成预览计划
- 真实动作执行尚未接入（当前是协议联调与手动验证阶段）

## 下一步

1. 为动作库补“质量评分诊断”字段，便于快速定位低质量通道。
2. 增加跨模型统计，评估哪些通道最稳定可复用。
3. 与前端执行器联动后，再收敛动作库字段和筛选策略。
