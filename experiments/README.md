# 千问桌宠表情数据

目标小模型是 Qwen3.5 2B。当前阶段从 DeepSeek 生成记录和 VTube Studio 录制中导出毫秒动作候选，供回放筛选和后续微调使用。

在本目录运行以下 PowerShell 命令。可以单独指定 Motion Lab 数据库，也可以重复传入 `--vts-db`。每次导出读取各数据库的一致快照，在 `data/timed/` 下建立独立目录。新录制正常结束后，重跑同一命令即可包含新增的 take。

```powershell
$motionDb = 'C:\Users\Administrator\Downloads\AstrBot\data\plugin_data\astrbot_plugin_ag99live_adapter\state\motion_lab.sqlite3'
python .\export_timed_dataset.py --motion-db $motionDb --vts-db "$env:LOCALAPPDATA\AG99live\vts-data-recorder\recordings.sqlite3"
```

`candidates.jsonl` 每行是一段台词的 OpenAI messages，assistant 输出形如 `[{"ms":240,"gaze_x":54},{"ms":380}]`。`manifest.jsonl` 按行记录原始样本或录制场次、时间区间和内容哈希，`report.json` 统计来源和跳过原因。每次导出都是全量快照，跨批次整理时按 `sample_id` 去重，划分评估集时按录制场次或对话轮次分组。

生成记录保留 DeepSeek 原始数组与适配器接受结果一致的样本，保留当时输入里的预计朗读时长。VTS 使用原始参数帧和转写时间计算目标毫秒数，轴越界或存在超过三个采样周期的空档时跳过该片段。VTS 的实际片段时长只用于构建目标和复核。所有候选均待审阅，可按清单回听转写、检查表演幅度。

默认匹配 VTS 模型 Mk6 和 Mk6_1.0 的语义轴配置。更换模型时同时指定 `--vts-model-name` 与 `--profile`。历史录制一直标记为 recording 时，可传 `--include-open-takes` 从当前快照取回有连续帧的片段，后续转写仍可能修订。使用 `--provider-id` 可指定本机 DeepSeek 提供方的完整 ID。

历史 Spark 脚本、训练配置与本地产物见[旧实验归档](archive/spark-x26/README.md)。
