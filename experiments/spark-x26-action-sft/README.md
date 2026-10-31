# Spark-X2.6-1.7B Action SFT Experiment

This isolated experiment checks whether the local training and inference path can
teach Spark-X2.6-1.7B to return parseable AG99live motion payloads. It is a
pipeline smoke run, not an action-quality evaluation or a generalization claim.

The weak-label source is the AG99live Motion Lab database. The default dataset
selects closed, structurally reviewable `independent_motion` /
`M2_olv_incremental` samples without a NeuroBrain snapshot. Labels are the
provider's final accepted payloads; they are not marked as human-approved. The
current database yields 16 examples for this default variant.

The training input keeps the actual provider user prompt but substitutes a
short experiment-specific system instruction for the original long system
prompt. This checks the SFT path and output contract without claiming to
reproduce the production provider context.

That short-prompt dataset is retained for comparison. The production-prompt
variant below instead reuses each captured request's complete system prompt,
recent chat contexts, and current user prompt. Its assistant target is projected
from the normalized Motion Lab target onto the fields accepted from an
independent-motion Provider; AG99live adds runtime identity and schema fields
after Provider validation. All 234 current examples, including their targets,
fit within the separate 6144-token training cutoff.

The separate production-prompt variant reuses each captured request's complete
system prompt, recent chat contexts, and current user prompt. Its assistant
target is projected from the normalized Motion Lab target onto the fields
accepted from an independent-motion Provider. Runtime identity and schema
fields are omitted because AG99live adds them after Provider validation. All
234 current examples fit, including their targets, within a 6144-token cutoff.

Generated datasets, downloaded model files, training checkpoints, and smoke
reports stay in ignored local directories. Do not commit those artifacts.

## Setup

Run PowerShell from this directory:

```powershell
.\setup.ps1
```

This creates a local Python 3.11 virtual environment and installs the pinned
XHToken LLaMA-Factory fork plus CUDA-enabled PyTorch. It does not modify the
global Python environment. The first setup and model download require several
gigabytes of disk and network transfer.

## Prepare weak labels

```powershell
$db = 'C:\Users\Administrator\Downloads\AstrBot\data\plugin_data\astrbot_plugin_ag99live_adapter\state\motion_lab.sqlite3'
.\.venv\Scripts\python.exe .\prepare_dataset.py --db $db
```

The script reads the database through the existing read-only reducer and writes
`data/weak_sft.jsonl` plus `data/dataset_info.json`. It prints counts only; it
does not print dialogue text.

## NeuroBrain-conditioned training

To include NeuroBrain as an input signal, prepare a separate variant:

```powershell
$db = 'C:\Users\Administrator\Downloads\AstrBot\data\plugin_data\astrbot_plugin_ag99live_adapter\state\motion_lab.sqlite3'
.\.venv\Scripts\python.exe .\prepare_dataset.py --db $db --include-neurobrain --output-dir .\data\neurobrain
```

This variant includes closed `independent_motion` / `M2_olv_incremental`
samples whose only quality blocker is `neurobrain_state_present`, along with
the clean samples. It verifies that the recorded state is present in the actual
provider prompt. Other blocked samples and open or incomplete collections stay
excluded. These are weak provider labels, not human-approved action labels.
The generated dataset and adapter stay separate from the original no-NeuroBrain
run.

Train that variant with:

```powershell
.\run_train_neurobrain.ps1
```

For the next production-prompt run using the captured DeepSeek prompt and
Provider-shaped action target, prepare the accumulated eligible samples and
train with:

```powershell
.\.venv\Scripts\python.exe .\prepare_dataset.py --db $db --include-neurobrain --production-prompt --output-dir .\data\production_neurobrain_v3
.\run_train_production_neurobrain.ps1
```

The production-prompt configuration coalesces adjacent messages with the same
role because LLaMA-Factory requires alternating user and assistant turns. It
retains their text in order and masks historical assistant responses from the
loss, so only the final action JSON is a training target. Samples are excluded
when the captured Provider prompt has an empty segment.speech; the SFT target
contains motion fields but omits intent_tags, which remain available in the
Motion Lab records for review. The dataset report includes target-shape counts
so the share of motion_steps examples is visible before training.

This run starts from the base checkpoint and trains on the full accumulated
eligible dataset, including previous and newly collected DeepSeek samples. It
has no fixed sample cap and writes a new v6 adapter directory, preserving the
previous v5 adapter. This gives new teacher samples their context without
training only on a small recent batch. It uses NF4 4-bit LoRA and one epoch;
training loss alone is not evidence of action quality.

On 2026-10-30 the production-prompt v5 run completed 234 steps in 4051 seconds
with training loss 0.5779. Five-minute-plus long-sample steps coincided with GPU
shared-memory pressure. The resulting adapter is an experiment, not a deployed
Provider.

For a seen-sample structure check using the matching saved tokenizer template:

```powershell
$env:HF_HOME = Join-Path (Get-Location) '.cache\huggingface'
.\.venv\Scripts\python.exe .\evaluate_production.py --adapter-dir .\output\spark-x26-1p7b-lora-production-neurobrain-v6 --report-path .\reports\production_neurobrain_v6_evaluation_20_matched.json --samples 20
```

The evaluator uses the saved training tokenizer and the masked `</think>`
prefix used by the Spark training template. Four sampled prompts were checked
token-for-token against the training template. Loading the base tokenizer's
original template instead alters the system framing and degraded the same
20-sample JSON result from 20/20 to 17/20; adding a second thinking prefix
degraded it further. With the matching template, all 20 were strict JSON, and
19 passed the strict captured-capability checks. One repeated an intent tag;
the runtime normally deduplicates tags. These are training examples, the checks
do not invoke AstrBot's runtime validation, and they do not establish unseen
input or action quality. The evaluator loads the base model in BF16, not the
NF4 training representation.

The v6 evaluator reports target/generated motion-shape agreement and
motion_steps counts. By default it samples motion_steps targets first (up to
half the requested examples when available), then fills the rest from other
shapes; --indices overrides this selection. These remain structural checks on
training prompts, so inspect held-out DeepSeek comparisons manually before
treating sequence quality as improved.

To measure a warm Ollama Q8 backend against full captured production prompts:

```powershell
$env:HF_HOME = Join-Path (Get-Location) '.cache\huggingface'
.\.venv\Scripts\python.exe .\benchmark_ollama_production.py --report-path .\reports\ollama_full_prompt_speed_proxy.json
```

On the RTX 4070 on 2026-10-30, after one warmup request, three 4,183-5,183
token prompts completed in 823-947 ms while generating 52-88 tokens. The first
request, which included model loading, took 3.02 seconds. This benchmark used
the existing Q8 action adapter rather than the newly trained v5 adapter, so it
was only an early backend speed proxy. The report contains timing and JSON-
validity metrics only, not prompt or response text; the exact v5 measurement is
below.

The production v5 adapter was then merged, converted to Q8_0 GGUF, and loaded
under the separate Ollama tag `ag99-spark-x26-action-v5:q8_test`. With the full
captured prompts, 8 warm requests on the RTX 4070 took 468-788 ms while
generating 39-67 tokens; all 8 outputs parsed as JSON. Prompt lengths were
4,362-5,701 tokens, and Ollama's prompt token counts matched the trained
tokenizer. A cold request that included model loading took 2.76 seconds. The
under-one-second result therefore applies to a loaded, warm Ollama model with a
6144-token context. This local test tag is not wired into AstrBot or AG99live;
Provider validation, JSON recovery, and Live2D playback were not exercised.
Repeating the same 8 prompts produced 7 valid JSON outputs in 452-751 ms. One
output reached the 128-token generation cap without closing its JSON and took
1,292 ms. This makes sub-second latency typical for compact valid actions, not
a per-request guarantee; malformed or overlong generations can exceed it.
See `reports/production_neurobrain_v5_ollama_q8_speed_8.json` for the repeat.

The short-prompt NeuroBrain config trains all examples for three epochs. It
does not alter the Motion Lab review/export rules or the AG99live runtime.

The 2026-10-30 run used 234 examples, including 218 NeuroBrain states, for 702
steps. It completed in 305.2 seconds with `train_loss=0.2457`. Training loss is
not an output-quality or generalization metric.

## Train

```powershell
.\run_train.ps1
```

Training uses BF16 LoRA, rank 8, one sample per device, gradient checkpointing,
and three epochs over the weak-label set. The original no-NeuroBrain run uses 16
samples. The separate NeuroBrain-conditioned run uses every closed M2 sample
that passes its experiment-specific input and payload checks. Repetition can
overfit and does not establish behavior on unseen conversations.

## Check generation

```powershell
.\run_smoke.ps1
```

The smoke script loads the base model and saved adapter, disables thinking,
generates three times from one prepared prompt, and records only parse status,
required-key status, exact-repeat stability, and latency in `reports/`.
That prompt is the first training example, so this is a memorization/pipeline
check rather than held-out evaluation. Latency excludes model loading.

To run the same three-generation structure check with the NeuroBrain adapter:

```powershell
.\.venv\Scripts\python.exe .\smoke_generate.py --adapter-dir .\output\spark-x26-1p7b-lora-neurobrain --data-path .\data\neurobrain\weak_sft.jsonl --report-path .\reports\neurobrain_generation_smoke.json
```

The 2026-10-30 smoke run passed JSON and motion-shape checks on all 3 runs,
with identical greedy outputs. It generated 147 tokens per run in 7.4–7.9
seconds on the Transformers BF16 path. The prompt is a training example, so
this is a seen-sample stability check, not held-out generalization. Its speed is
not directly comparable to the Ollama Q8_0 benchmark below.

## Measure generation speed

Run the separate GPU benchmark:

```powershell
.\run_speed_benchmark.ps1
```

It loads the same base model and LoRA adapter, warms up once, then measures five
greedy generations of 128 tokens, with and without the Transformers streamer.
The paired runs quantify streamer overhead. The report records prompt length,
time to the first generated token (including prompt prefill), total generation
time, end-to-end tokens/s, and decode tokens/s after the first token. Model
loading and tokenization are excluded. It records timings only and does not
inspect or print generated text. Use `--runs`, `--warmup-runs`, or
`--new-tokens` to change the measurement via the PowerShell wrapper.

## Ollama backend trial

`merge_adapter.py` merges the LoRA into its exact `XHToken/Spark-X2.6-1.7B-Base`
checkpoint and saves that base model's tokenizer. The merged checkpoint was
converted to Q8_0 GGUF with the llama.cpp converter and imported into Ollama as
`ag99-spark-x26-action-lora:q8_0`. This is a standalone test model; AG99live's
runtime is not wired to it.

On the RTX 4070, Ollama generated 128 tokens from the same 449-token prompt in
five warm runs at a median of 127.95 tokens/s (125.39–131.69). The Qwen 2B Q8_0
comparison measured 134.02 tokens/s. The Transformers BF16 path measured about
14 tokens/s. This benchmark measures speed only; it does not verify action
quality or compare generated outputs.

Run the imported model with:

```powershell
ollama run ag99-spark-x26-action-lora:q8_0
```

For the same prompt and decoding settings without the adapter, run:

```powershell
.\run_smoke.ps1 --base-only
```

This command records baseline metrics even when the base model fails the output
checks. In the current run, base-only produced valid JSON on 0/3 runs; the
fine-tuned adapter passed this experiment's structural motion checks on 3/3
runs with identical outputs. This shows the adapter learned the requested
output form on a seen example, not that it generalizes to new conversations or
passes the full frontend compiler and Live2D execution path.

## Scope

- No changes to AG99live runtime or public protocol.
- No NeuroBrain samples or VTube Studio parameter recordings.
- No claim about semantic action quality, visual naturalness, or held-out
  generalization.
- No full-parameter training.
