export interface ReactionActionTemplate {
  id: string;
  label: string;
  description: string;
  emotionLabel: string;
  semanticGroups: readonly string[];
  axisIds: readonly string[];
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
    description: "待机时低幅左右转头和侧倾，保持自然的头身轻晃。",
    emotionLabel: "calm",
    semanticGroups: ["head", "body"],
    axisIds: ["head_yaw", "head_roll", "body_yaw", "body_roll"],
    axisCount: 2,
    durationMs: 1_800,
    intensityScale: 0.34,
    triggers: ["idle", "waiting"],
  },
  {
    id: "small_glance",
    label: "小幅扫视",
    description: "轻微左右移动视线和头部，平缓扫视后回中。",
    emotionLabel: "attentive",
    semanticGroups: ["gaze", "head"],
    axisIds: ["gaze_x", "head_yaw"],
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
    axisIds: ["head_pitch", "body_pitch"],
    axisCount: 2,
    durationMs: 1_600,
    intensityScale: 0.28,
    triggers: ["acknowledge"],
  },
  {
    id: "breath_pause",
    label: "呼吸停顿",
    description: "以呼吸轴和身体轻微变化维持自然的等待状态。",
    emotionLabel: "resting",
    semanticGroups: ["breath", "body"],
    axisIds: ["breath", "body_roll"],
    axisCount: 2,
    durationMs: 2_200,
    intensityScale: 0.22,
    triggers: ["rest"],
  },
  {
    id: "relaxed_sway",
    label: "舒缓侧摆",
    description: "待机时缓慢左右侧摆身体，再平滑回中。",
    emotionLabel: "resting",
    semanticGroups: ["body"],
    axisIds: ["body_yaw", "body_roll"],
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
    axisIds: ["gaze_x", "head_yaw", "head_roll"],
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
    axisIds: ["gaze_x", "head_yaw"],
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
    axisIds: ["head_pitch", "head_yaw", "body_yaw", "breath"],
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
    axisIds: ["head_pitch", "head_yaw", "brow_bias", "eye_open_left", "eye_open_right"],
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
    axisIds: ["gaze_x", "head_yaw", "head_roll", "body_yaw", "body_roll"],
    axisCount: 3,
    durationMs: 2_300,
    intensityScale: 0.2,
    triggers: ["attention_release", "cursor_release", "desktop_release"],
  },
];

export const IDLE_REACTION_ACTIONS: readonly ReactionActionTemplate[] =
  REACTION_ACTION_CATALOG.filter((template) =>
    template.triggers.includes("idle") || template.triggers.includes("waiting"));

export function getReactionActionTemplate(
  actionId: string,
): ReactionActionTemplate | null {
  const normalized = actionId.trim();
  return REACTION_ACTION_CATALOG.find((template) => template.id === normalized) ?? null;
}
