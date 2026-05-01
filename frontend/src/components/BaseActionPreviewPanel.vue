<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useDesktopBridge } from "../composables/useDesktopBridge";
import type {
  DesktopBaseActionPreview,
  DesktopBaseActionPreviewAtom,
} from "../types/desktop";
import type {
  SemanticMotionIntent,
} from "../types/protocol";
import { SCHEMA_MOTION_INTENT_V2 } from "../types/protocol";
import type { SemanticAxisProfile } from "../types/semantic-axis-profile";
import { useParameterExcludeKeywords } from "../composables/useParameterExcludeKeywords";
import { buildParameterPlanTiming } from "../model-engine/timing";

const props = defineProps<{
  preview: DesktopBaseActionPreview | null;
  semanticProfile: SemanticAxisProfile | null;
  allowPlay?: boolean;
}>();
const bridge = useDesktopBridge();

const selectedChannel = ref("all");
const selectedDomain = ref("all");
const searchText = ref("");
const {
  excludedParameterKeywordsText,
  parameterExcludeKeywords,
  persistParameterExcludeKeywords,
  resetParameterExcludeKeywords,
} = useParameterExcludeKeywords();
const selectedAtomIds = ref<string[]>([]);
const planMode = ref<"parallel" | "sequential">("parallel");
const durationScale = ref(1);
const intensityScale = ref(1);
const stepGapMs = ref(120);

const LLM_CONTROLLABLE_ROLES = new Set(["primary", "hint"]);

const channelsByName = computed(() => {
  const channels = props.preview?.channels ?? [];
  return new Map(channels.map((channel) => [channel.name, channel]));
});
const atomsById = computed(() => {
  const atoms = props.preview?.atoms ?? [];
  return new Map(atoms.map((atom) => [atom.id, atom]));
});

const channelOptions = computed(() => {
  const channels = props.preview?.channels ?? [];
  return [...channels].sort((left, right) => {
    if (right.selectedAtomCount !== left.selectedAtomCount) {
      return right.selectedAtomCount - left.selectedAtomCount;
    }
    return left.label.localeCompare(right.label);
  });
});

const domainOptions = computed(() => {
  const channels = props.preview?.channels ?? [];
  return [...new Set(channels.map((channel) => channel.domain))].sort();
});

const filteredAtoms = computed<DesktopBaseActionPreviewAtom[]>(() => {
  const atoms = props.preview?.atoms ?? [];
  const query = searchText.value.trim().toLowerCase();
  const excludedKeywords = parameterExcludeKeywords.value;
  return atoms.filter((atom) => {
    if (selectedChannel.value !== "all" && atom.channel !== selectedChannel.value) {
      return false;
    }
    if (selectedDomain.value !== "all" && atom.domain !== selectedDomain.value) {
      return false;
    }
    if (atomMatchesExcludedParameterKeyword(atom, excludedKeywords)) {
      return false;
    }
    if (!query) {
      return true;
    }
    const haystack = [
      atom.id,
      atom.channelLabel,
      atom.familyLabel,
      atom.semanticPolarity,
      atom.trait,
      atom.sourceMotion,
      atom.sourceFile,
      atom.sourceGroup,
      atom.sourceCategory,
      atom.sourceTags.join(" "),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
});
const excludedAtomCount = computed(() =>
  (props.preview?.atoms ?? []).filter((atom) =>
    atomMatchesExcludedParameterKeyword(atom, parameterExcludeKeywords.value),
  ).length,
);

const groupedAtoms = computed(() => {
  const groups = new Map<string, DesktopBaseActionPreviewAtom[]>();
  for (const atom of filteredAtoms.value) {
    const bucket = groups.get(atom.channel) ?? [];
    bucket.push(atom);
    groups.set(atom.channel, bucket);
  }
  return [...groups.entries()]
    .map(([channelName, atoms]) => ({
      channelName,
      channelMeta: channelsByName.value.get(channelName),
      atoms,
    }))
    .sort((left, right) => right.atoms.length - left.atoms.length);
});

const analysisBadgeLabel = computed(() => {
  const analysis = props.preview?.analysis;
  if (!analysis) {
    return "not-ready";
  }
  return `${analysis.status}/${analysis.mode}`;
});
const actionLibraryFailed = computed(() => props.preview?.analysis.status === "failed");
const actionLibraryReady = computed(() => Boolean(props.preview) && !actionLibraryFailed.value);

const selectedAtomIdSet = computed(() => new Set(selectedAtomIds.value));
const selectedAtoms = computed<DesktopBaseActionPreviewAtom[]>(() => {
  const map = atomsById.value;
  return selectedAtomIds.value
    .map((atomId) => map.get(atomId))
    .filter((atom): atom is DesktopBaseActionPreviewAtom => Boolean(atom));
});
const controllableAxisIds = computed(() =>
  new Set(
    (props.semanticProfile?.axes ?? [])
      .filter((axis) => LLM_CONTROLLABLE_ROLES.has(axis.control_role))
      .map((axis) => axis.id),
  ),
);
function buildPlanStep(
  atom: DesktopBaseActionPreviewAtom,
  startMs: number,
): {
  atom_id: string;
  channel: string;
  start_ms: number;
  duration_ms: number;
  intensity: number;
  source_motion: string;
  source_file: string;
  source_group: string;
  semantic_polarity: string;
  trait: string;
} {
  const durationMs = Math.max(
    80,
    Math.round(atom.duration * 1000 * durationScale.value),
  );
  const baseIntensity = strengthToBaseIntensity(atom.strength);
  const intensity = roundTo(
    Math.min(Math.max(baseIntensity * intensityScale.value, 0), 2),
    3,
  );

  return {
    atom_id: atom.id,
    channel: atom.channel,
    start_ms: startMs,
    duration_ms: durationMs,
    intensity,
    source_motion: atom.sourceMotion,
    source_file: atom.sourceFile,
    source_group: atom.sourceGroup,
    semantic_polarity: atom.semanticPolarity,
    trait: atom.trait,
  };
}

const generatedPlan = computed(() => {
  const steps: Array<ReturnType<typeof buildPlanStep>> = [];
  let cursorMs = 0;
  for (const atom of selectedAtoms.value) {
    const startMs = planMode.value === "parallel" ? 0 : cursorMs;
    const step = buildPlanStep(atom, startMs);
    steps.push(step);
    if (planMode.value === "sequential") {
      cursorMs += step.duration_ms + Math.max(0, Math.round(stepGapMs.value));
    }
  }

  const totalDurationMs =
    planMode.value === "parallel"
      ? Math.max(...steps.map((step) => step.duration_ms), 0)
      : Math.max(cursorMs - Math.max(0, Math.round(stepGapMs.value)), 0);

  const axisValues = buildSemanticAxisValuesFromAtoms(selectedAtoms.value);
  const expressive = Object.values(axisValues).some((axisValue) => axisValue.value !== 50);
  const timing = buildParameterPlanTiming(
    expressive ? Math.max(totalDurationMs, 900) : Math.max(totalDurationMs, 480),
    expressive ? "expressive" : "idle",
  );
  const profile = props.semanticProfile;
  const intent: SemanticMotionIntent = {
    schema_version: SCHEMA_MOTION_INTENT_V2,
    profile_id: profile?.profile_id ?? "",
    profile_revision: profile?.revision ?? 0,
    model_id: profile?.model_id ?? "",
    mode: expressive ? "expressive" : "idle",
    emotion_label: selectedAtoms.value[0]?.semanticPolarity || "preview",
    duration_hint_ms: timing.duration_ms,
    axes: axisValues,
    summary: {
      axis_count: Object.keys(axisValues).length,
    },
  };

  return {
    ...intent,
    selected_atom_count: selectedAtoms.value.length,
    channels: [...new Set(selectedAtoms.value.map((atom) => atom.channel))],
    parameters: {
      duration_scale: roundTo(durationScale.value, 3),
      intensity_scale: roundTo(intensityScale.value, 3),
      sequential_gap_ms: Math.max(0, Math.round(stepGapMs.value)),
      combination_mode: planMode.value,
    },
    summary: {
      axis_count: Object.keys(axisValues).length,
      total_duration_ms: totalDurationMs,
      step_count: steps.length,
    },
    steps,
  };
});
const generatedPlanText = computed(() =>
  JSON.stringify(generatedPlan.value, null, 2),
);
const playButtonEnabled = computed(
  () =>
    Boolean(props.allowPlay)
    && actionLibraryReady.value
    && Boolean(props.semanticProfile)
    && selectedAtoms.value.length > 0
    && Object.keys(buildSemanticAxisValuesFromAtoms(selectedAtoms.value)).length > 0,
);
const playStatusText = ref("");

watch(
  () => filteredAtoms.value.map((atom) => atom.id).join("|"),
  () => {
    const allowed = new Set(filteredAtoms.value.map((atom) => atom.id));
    selectedAtomIds.value = selectedAtomIds.value.filter((id) => allowed.has(id));
  },
  { immediate: true },
);

function toggleAtomSelection(atomId: string): void {
  if (selectedAtomIdSet.value.has(atomId)) {
    selectedAtomIds.value = selectedAtomIds.value.filter((item) => item !== atomId);
    return;
  }
  selectedAtomIds.value = [...selectedAtomIds.value, atomId];
}

function selectFilteredAtoms(): void {
  if (!actionLibraryReady.value) {
    return;
  }
  const merged = new Set(selectedAtomIds.value);
  for (const atom of filteredAtoms.value) {
    merged.add(atom.id);
  }
  selectedAtomIds.value = [...merged];
}

function clearSelectedAtoms(): void {
  selectedAtomIds.value = [];
}

function atomMatchesExcludedParameterKeyword(
  atom: DesktopBaseActionPreviewAtom,
  keywords: string[],
): boolean {
  if (!keywords.length) {
    return false;
  }
  const haystack = [
    atom.id,
    atom.name,
    atom.label,
    atom.domain,
    atom.channel,
    atom.channelLabel,
    atom.family,
    atom.familyLabel,
    atom.sourceMotion,
    atom.sourceFile,
    atom.sourceGroup,
    atom.sourceCategory,
    atom.sourceTags.join(" "),
  ].join(" ").toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword));
}

function playPreviewPlan(): void {
  if (!playButtonEnabled.value) {
    playStatusText.value = actionLibraryFailed.value
      ? "动作库构建失败，请先处理上方错误后再测试播放。"
      : props.semanticProfile
      ? "请至少选择一个能映射到主轴/提示轴的动作原子。"
      : "当前模型还没有 semantic profile，无法生成 v2 动作预览。";
    return;
  }
  bridge.sendCommand({
    type: "preview_motion_plan",
    plan: generatedPlan.value,
  });
  playStatusText.value = `已发送测试播放计划（${selectedAtoms.value.length} steps）`;
}

function strengthToBaseIntensity(strength: string): number {
  switch (strength) {
    case "none":
      return 0;
    case "low":
      return 0.35;
    case "medium":
      return 0.7;
    case "high":
      return 1;
    default:
      return 0.5;
  }
}

function semanticPolarityToDirection(polarity: string): number {
  switch (polarity) {
    case "positive":
      return 1;
    case "negative":
      return -1;
    default:
      return 0;
  }
}

function buildAxisValuesFromAtoms(
  atoms: DesktopBaseActionPreviewAtom[],
): SemanticMotionIntent["axes"] {
  const axisValues: SemanticMotionIntent["axes"] = {};
  const strongestByChannel = new Map<string, DesktopBaseActionPreviewAtom>();
  for (const atom of atoms) {
    if (!controllableAxisIds.value.has(atom.channel)) {
      continue;
    }
    const current = strongestByChannel.get(atom.channel);
    if (!current) {
      strongestByChannel.set(atom.channel, atom);
      continue;
    }
    if (atom.score > current.score) {
      strongestByChannel.set(atom.channel, atom);
      continue;
    }
    if (atom.score === current.score && atom.energyScore > current.energyScore) {
      strongestByChannel.set(atom.channel, atom);
    }
  }

  for (const axisName of controllableAxisIds.value) {
    const atom = strongestByChannel.get(axisName);
    if (!atom) {
      continue;
    }
    const direction = semanticPolarityToDirection(atom.semanticPolarity || atom.polarity);
    if (direction === 0) {
      continue;
    }
    const baseIntensity = strengthToBaseIntensity(atom.strength);
    const magnitude = Math.max(
      0,
      Math.min(45, Math.round(baseIntensity * intensityScale.value * 35)),
    );
    axisValues[axisName] = {
      value: Math.max(0, Math.min(100, 50 + direction * magnitude)),
    };
  }

  return axisValues;
}

function buildSemanticAxisValuesFromAtoms(
  atoms: DesktopBaseActionPreviewAtom[],
): SemanticMotionIntent["axes"] {
  return buildAxisValuesFromAtoms(atoms);
}

function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
</script>

<template>
  <article class="settings-card settings-card--wide">
    <div class="settings-card__header">
      <div>
        <p class="settings-card__eyebrow">动作拆分预览</p>
        <h2>参数动作原子池</h2>
      </div>
      <span class="settings-card__badge">{{ analysisBadgeLabel }}</span>
    </div>

    <template v-if="preview">
      <dl class="settings-card__meta action-preview__summary-grid">
        <div>
          <dt>动作原子</dt>
          <dd>{{ preview.summary.selectedAtomCount }}</dd>
        </div>
        <div>
          <dt>候选组件</dt>
          <dd>{{ preview.summary.candidateComponentCount }}</dd>
        </div>
        <div>
          <dt>通道覆盖</dt>
          <dd>
            {{ preview.summary.selectedChannelCount }}/{{ preview.summary.availableChannelCount }}
          </dd>
        </div>
        <div>
          <dt>动作家族</dt>
          <dd>{{ preview.summary.familyCount }}</dd>
        </div>
      </dl>

      <div class="action-preview__analysis">
        <span>Provider: {{ preview.analysis.providerId || "rule-seed only" }}</span>
        <span>Latency: {{ preview.analysis.latencyMs }}ms</span>
        <span>Cache: {{ preview.analysis.cacheHit ? "hit" : "miss" }}</span>
      </div>
      <p v-if="preview.analysis.error" class="action-preview__error">
        {{ preview.analysis.error }}
      </p>
      <p v-if="actionLibraryFailed" class="settings-card__hint action-preview__failure-hint">
        动作库处于 failed 状态，当前参数动作池不可用于筛选或测试播放。
      </p>

      <div class="action-preview__filters">
        <label class="action-preview__field">
          <span>通道</span>
          <select v-model="selectedChannel" class="settings-card__input action-preview__select">
            <option value="all">全部通道</option>
            <option
              v-for="channel in channelOptions"
              :key="channel.name"
              :value="channel.name"
            >
              {{ channel.label }} ({{ channel.selectedAtomCount }})
            </option>
          </select>
        </label>

        <label class="action-preview__field">
          <span>域</span>
          <select v-model="selectedDomain" class="settings-card__input action-preview__select">
            <option value="all">全部域</option>
            <option v-for="domain in domainOptions" :key="domain" :value="domain">
              {{ domain }}
            </option>
          </select>
        </label>

        <label class="action-preview__field action-preview__field--search">
          <span>搜索</span>
          <input
            v-model="searchText"
            class="settings-card__input"
            placeholder="按 id / source motion / trait 搜索"
          />
        </label>

        <label class="action-preview__field">
          <span>排除关键词</span>
          <textarea
            v-model="excludedParameterKeywordsText"
            class="motion-tuning__textarea"
            placeholder="hair&#10;bind&#10;physics"
            @change="persistParameterExcludeKeywords"
          />
        </label>
      </div>

      <p class="settings-card__hint">
        当前过滤后共有 {{ filteredAtoms.length }} 个原子动作，已隐藏 {{ excludedAtomCount }} 个匹配排除关键词的动作。
      </p>
      <div class="action-preview__selection-actions">
        <button
          type="button"
          class="settings-card__button settings-card__button--ghost"
          :disabled="!actionLibraryReady"
          @click="selectFilteredAtoms"
        >
          选中当前筛选
        </button>
        <button
          type="button"
          class="settings-card__button settings-card__button--ghost"
          :disabled="!actionLibraryReady"
          @click="clearSelectedAtoms"
        >
          清空选择
        </button>
        <button
          type="button"
          class="settings-card__button settings-card__button--ghost"
          @click="persistParameterExcludeKeywords"
        >
          应用排除
        </button>
        <button
          type="button"
          class="settings-card__button settings-card__button--ghost"
          @click="resetParameterExcludeKeywords"
        >
          默认排除
        </button>
        <span>已选 {{ selectedAtoms.length }} 个动作原子</span>
      </div>

      <div v-if="groupedAtoms.length" class="action-preview__groups">
        <section
          v-for="group in groupedAtoms"
          :key="group.channelName"
          class="action-preview__group"
        >
          <header class="action-preview__group-header">
            <strong>
              {{ group.channelMeta?.label ?? group.channelName }}
            </strong>
            <span>{{ group.atoms.length }} atoms</span>
          </header>

          <ul class="action-preview__atom-list">
            <li
              v-for="atom in group.atoms"
              :key="atom.id"
              class="action-preview__atom-item"
              :data-selected="selectedAtomIdSet.has(atom.id)"
              @click="toggleAtomSelection(atom.id)"
            >
              <label class="action-preview__atom-check">
                <input
                  type="checkbox"
                  :checked="selectedAtomIdSet.has(atom.id)"
                  @click.stop="toggleAtomSelection(atom.id)"
                />
              </label>
              <div class="action-preview__atom-main">
                <strong>{{ atom.id }}</strong>
                <p>
                  {{ atom.sourceMotion }} · {{ atom.semanticPolarity }} · {{ atom.trait }} ·
                  {{ atom.strength }}
                </p>
              </div>
              <div class="action-preview__atom-metrics">
                <span>score {{ atom.score.toFixed(2) }}</span>
                <span>energy {{ atom.energyScore.toFixed(2) }}</span>
                <span>{{ atom.duration.toFixed(2) }}s</span>
              </div>
            </li>
          </ul>
        </section>
      </div>
      <p v-else class="history-empty">当前筛选条件下没有动作原子。</p>

      <section class="action-preview__plan">
        <header class="action-preview__plan-header">
          <strong>临时播放计划（测试）</strong>
          <span>仅用于预览 engine 输入，不会触发真实播放</span>
        </header>

        <div class="action-preview__plan-controls">
          <label class="action-preview__field">
            <span>组合模式</span>
            <select v-model="planMode" class="settings-card__input action-preview__select">
              <option value="parallel">并行</option>
              <option value="sequential">串行</option>
            </select>
          </label>

          <label class="action-preview__field">
            <span>时长倍率</span>
            <input
              v-model.number="durationScale"
              class="settings-card__input"
              type="number"
              step="0.1"
              min="0.1"
              max="5"
            />
          </label>

          <label class="action-preview__field">
            <span>强度倍率</span>
            <input
              v-model.number="intensityScale"
              class="settings-card__input"
              type="number"
              step="0.1"
              min="0"
              max="3"
            />
          </label>

          <label class="action-preview__field">
            <span>串行间隔(ms)</span>
            <input
              v-model.number="stepGapMs"
              class="settings-card__input"
              type="number"
              step="10"
              min="0"
              max="5000"
            />
          </label>
        </div>

        <textarea
          class="action-preview__plan-output"
          :value="generatedPlanText"
          readonly
        />
        <div v-if="allowPlay" class="action-preview__plan-actions">
          <button
            type="button"
            class="settings-card__button"
            :disabled="!playButtonEnabled"
            @click="playPreviewPlan"
          >
            播放测试
          </button>
          <span>{{ playStatusText }}</span>
        </div>
      </section>
    </template>

    <p v-else class="history-empty">
      还没有拿到 parameter action library。请先连接适配器并完成模型同步。
    </p>
  </article>
</template>
