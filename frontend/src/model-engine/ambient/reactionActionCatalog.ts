export interface ReactionActionTemplate {
  id: string;
  label: string;
  description: string;
  emotionLabel: string;
  semanticGroups: readonly string[];
  axisHints: readonly string[];
  axisCount: number;
  durationMs: number;
  intensityScale: number;
  triggers: readonly string[];
}

/**
 * Hand-authored semantic action recipes. They resolve against the selected
 * model profile at runtime, so the catalog never stores raw model parameters.
 */
export const REACTION_ACTION_CATALOG: readonly ReactionActionTemplate[] = [
  {
    id: "soft_sway",
    label: "轻柔晃动",
    description: "待机时的低幅头身晃动，用来保持角色的呼吸感。",
    emotionLabel: "calm",
    semanticGroups: ["head", "body"],
    axisHints: ["yaw", "roll"],
    axisCount: 2,
    durationMs: 1_800,
    intensityScale: 0.34,
    triggers: ["idle", "waiting"],
  },
  {
    id: "small_glance",
    label: "小幅扫视",
    description: "轻微移动视线和头部，适合没有明确目标的注意力变化。",
    emotionLabel: "attentive",
    semanticGroups: ["gaze", "head"],
    axisHints: ["x", "y", "yaw", "gaze"],
    axisCount: 2,
    durationMs: 1_400,
    intensityScale: 0.28,
    triggers: ["idle", "attention"],
  },
  {
    id: "gentle_nod",
    label: "轻微点头",
    description: "低幅度点头和身体回应，适合确认或认可。",
    emotionLabel: "agreeable",
    semanticGroups: ["head", "body"],
    axisHints: ["pitch", "nod"],
    axisCount: 2,
    durationMs: 1_600,
    intensityScale: 0.28,
    triggers: ["idle", "acknowledge"],
  },
  {
    id: "breath_pause",
    label: "呼吸停顿",
    description: "以呼吸轴和身体轻微变化维持自然的等待状态。",
    emotionLabel: "resting",
    semanticGroups: ["breath", "body"],
    axisHints: ["breath", "roll"],
    axisCount: 2,
    durationMs: 2_200,
    intensityScale: 0.22,
    triggers: ["idle", "waiting"],
  },
  {
    id: "curious_tilt",
    label: "好奇歪头",
    description: "先移动视线，再用轻微侧倾表达好奇。",
    emotionLabel: "curious",
    semanticGroups: ["gaze", "head"],
    axisHints: ["gaze", "yaw", "roll"],
    axisCount: 3,
    durationMs: 2_400,
    intensityScale: 0.26,
    triggers: ["attention", "cursor", "desktop"],
  },
  {
    id: "quiet_attention",
    label: "安静注视",
    description: "幅度较小、保持时间较长的注视动作，适合等待和观察。",
    emotionLabel: "attentive",
    semanticGroups: ["gaze", "head"],
    axisHints: ["gaze", "yaw"],
    axisCount: 2,
    durationMs: 2_700,
    intensityScale: 0.24,
    triggers: ["attention", "cursor", "desktop"],
  },
  {
    id: "soft_acknowledge",
    label: "柔和回应",
    description: "点头、轻晃和呼吸组合成一段短回应。",
    emotionLabel: "acknowledge",
    semanticGroups: ["head", "body", "breath"],
    axisHints: ["pitch", "yaw", "breath"],
    axisCount: 3,
    durationMs: 2_000,
    intensityScale: 0.24,
    triggers: ["acknowledge", "conversation_gap"],
  },
  {
    id: "micro_surprise",
    label: "轻微惊讶",
    description: "短促抬头和表情变化，适合桌面变化或突发注意。",
    emotionLabel: "surprised",
    semanticGroups: ["head", "brow", "eye"],
    axisHints: ["pitch", "yaw", "brow", "open"],
    axisCount: 3,
    durationMs: 1_500,
    intensityScale: 0.2,
    triggers: ["desktop", "attention"],
  },
  {
    id: "settle_after_notice",
    label: "注意后回稳",
    description: "从注意动作回到中立，适合事件反应结束后的收束。",
    emotionLabel: "settling",
    semanticGroups: ["gaze", "head", "body"],
    axisHints: ["gaze", "yaw", "roll"],
    axisCount: 3,
    durationMs: 2_300,
    intensityScale: 0.2,
    triggers: ["attention_release", "cursor_release", "desktop_release"],
  },
];

export function getReactionActionTemplate(
  actionId: string,
): ReactionActionTemplate | null {
  const normalized = actionId.trim();
  return REACTION_ACTION_CATALOG.find((template) => template.id === normalized) ?? null;
}
