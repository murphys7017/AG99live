# Spark-X2.6 AG99live 连续动作训练实验

这个实验只训练新的 AG99live 连续动作输出协议，不兼容旧的 `axis_levels` 输出。

训练 assistant 目标严格为：

```json
{
  "motion_steps": [
    {"axis_values": {"head_yaw": 66.0}, "duration_weight": 1}
  ],
  "duration_hint_ms": 1200
}
```

`motion_steps` 为 1–4 步，单一姿态也必须使用 1 步；轴值是能力数据中对应 `value_range` 内的具体数值；`duration_hint_ms` 必须存在且为 320–15000 的整数。训练输入会去掉 `motion_guidance` 和 `neurobrain_state`，保留当前用户、Persona segment 与有界纯文本历史。

## 准备环境

```powershell
.\setup.ps1
```

脚本创建本地 Python 3.11 虚拟环境和固定版本的 LLaMA-Factory / PyTorch，不修改全局环境。

## 导出连续动作数据

```powershell
$db = 'C:\Users\Administrator\Downloads\AstrBot\data\plugin_data\astrbot_plugin_ag99live_adapter\state\motion_lab.sqlite3'
.\.venv\Scripts\python.exe .\prepare_dataset.py --db $db
```

默认输出：

- `data/continuous/continuous_sft.jsonl`
- `data/continuous/dataset_info.json`
- 数据集名：`spark_x26_continuous`

导出阶段会把历史根级 `axis_levels` 和旧 step 里的 `axis_levels` 转为具体 `axis_values`，保留步骤顺序；资源动作样本不会混入参数动作训练集。转换结果会打印源形态、转换状态和剔除原因，不打印对话正文。

需要使用成功的影子 Provider 作为教师时，可显式传入 `--teacher-provider-id`；`--teacher-fallback-primary`、`--relaxed-quality` 和 `--all-delivery-modes` 只改变离线样本筛选，不改变输出协议。

## 训练

```powershell
.\run_train.ps1
```

`train_lora.yaml` 使用 `data/continuous`，上下文截断为 6144 tokens，输出到 `output/spark-x26-1p7b-lora-continuous`。这是新的训练产物目录，不覆盖以前的 Adapter。

## 结构 Smoke 检查

```powershell
.\run_smoke.ps1
```

检查内容包括 JSON 可解析性、输出字段是否严格为 `motion_steps` 与 `duration_hint_ms`、step 数量、`duration_weight`、轴 ID、`value_range` 和连续数值范围。该检查使用第一条训练样本，只能证明生成管线和结构，不代表泛化或动作质量。

## 评估

```powershell
.\.venv\Scripts\python.exe .\evaluate_production.py `
  --adapter-dir .\output\spark-x26-1p7b-lora-continuous `
  --data-path .\data\continuous\continuous_sft.jsonl `
  --report-path .\reports\continuous_evaluation.json `
  --samples 20
```

评估脚本只接受新的连续动作形态；历史等级数据不再作为模型评估目标。

## 范围和限制

这是弱标签 SFT 管线。Motion Lab 目标来自 Provider 的已接受结果，不等同于人工标注；历史样本中的离散等级只是转换来源，转换不会增加新的语义标注。VTS 录制数据可以后续按时间窗映射为连续轴值，但在接入前仍需做文本清洗、切句抽检和语义一致性复核。
