import type { SemanticAxisControlRole, SemanticAxisCoupling } from "../types/semantic-axis-profile";

export const CONTROL_ROLE_OPTIONS: SemanticAxisControlRole[] = [
  "primary",
  "hint",
  "derived",
  "runtime",
  "ambient",
  "debug",
];

export const COUPLING_MODE_OPTIONS: SemanticAxisCoupling["mode"][] = [
  "same_direction",
  "opposite_direction",
];

export const PROFILE_QUICK_START = [
  "Axis 是语义控制槽，不是直接写进模型的 ParamXXX。先定义动作语义，再决定映射到哪些真实参数。",
  "Binding 负责把 axis 的 0~100 语义值映射到 Live2D 参数真实范围；一个真实参数只能归属一条 axis。",
  "Coupling 是轴间联动，只适合做从属跟随，不适合拿来替代主控输入。",
];

export const PROFILE_ROLE_GUIDE: Array<{ role: string; description: string }> = [
  { role: "primary", description: "给 LLM 直接控制的主表达轴，优先放最重要、最直观的动作。" },
  { role: "hint", description: "也允许 LLM 直接控制，但优先级低于 primary，适合补充细节。" },
  { role: "derived", description: "通常由 coupling 派生，不建议直接让 LLM 主控。" },
  { role: "runtime", description: "更适合运行时驱动，例如眨眼、口型、实时状态。" },
  { role: "ambient", description: "环境/待机相关轴，通常不进入当前回复动作主链路。" },
  { role: "debug", description: "调试或实验轴，正式链路尽量不要依赖。" },
];

export const PROFILE_FIELD_GUIDE: Array<{ label: string; description: string }> = [
  { label: "Neutral", description: "静止中心点。没有明显动作时，轴值应尽量靠近这里。" },
  { label: "Value Range", description: "这个 axis 的完整合法范围；soft/strong 都必须落在它里面。" },
  { label: "Soft Range", description: "轻微活动区。如果 expressive 输出仍全部落在 soft_range 内，前端可能判回 idle。" },
  { label: "Strong Range", description: "强表达参考区，主要给提示词和调参参考，不是硬阈值。" },
  { label: "Positive / Negative Semantics", description: "分别描述轴值变大、变小时代表什么语义，用来帮 LLM 理解方向。" },
];

export const PROFILE_BINDING_GUIDE = [
  "Parameter ID 填模型里真实存在的参数名，例如 ParamAngleX、ParamMouthForm。",
  "Input Range 一般与这个 axis 的语义输入区间一致，默认通常对齐 value_range。",
  "Output Range 填模型参数真实输出范围；如果方向相反，优先用 invert，不要把区间反着写。",
  "Weight 是该 binding 的默认强度，先从 1 开始，只有明显过强时再下调。",
];

export const PROFILE_COUPLING_GUIDE = [
  "Source Axis 是驱动方，Target Axis 是被带动方。",
  "Scale 控制跟随比例；Deadzone 控制多小的动作直接忽略；Max Delta 限制最多带动多少。",
  "优先保留少量、单向、好理解的 coupling，避免把 profile 配成难以预测的联动网。",
];
