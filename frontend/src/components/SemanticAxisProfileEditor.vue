<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useDesktopBridge } from "../composables/useDesktopBridge";
import type { DesktopHistoryEntry } from "../types/desktop";
import type {
  SemanticAxisControlRole,
  SemanticAxisDefinition,
  SemanticAxisProfile,
} from "../types/semantic-axis-profile";

type EditableRangeKey = "soft_range" | "strong_range";

const CONTROL_ROLE_OPTIONS: SemanticAxisControlRole[] = [
  "primary",
  "hint",
  "derived",
  "runtime",
  "ambient",
  "debug",
];

const bridge = useDesktopBridge();
const draftProfile = ref<SemanticAxisProfile | null>(null);
const draftBaseRevision = ref<number | null>(null);
const selectedAxisId = ref("");
const isDirty = ref(false);
const saveStatusText = ref("");
const pendingSave = ref<{
  expectedRevision: number;
  requestedAtMs: number;
} | null>(null);

const currentProfile = computed(
  () => bridge.state.snapshot.selectedSemanticAxisProfile,
);
const selectedModelName = computed(() =>
  bridge.state.snapshot.selectedModelName.trim(),
);
const historyEntries = computed(() => bridge.state.snapshot.historyEntries);
const draftAxes = computed(() => draftProfile.value?.axes ?? []);
const selectedAxis = computed<SemanticAxisDefinition | null>(() => {
  const axes = draftAxes.value;
  if (!axes.length) {
    return null;
  }
  return axes.find((axis) => axis.id === selectedAxisId.value) ?? axes[0] ?? null;
});
const canSave = computed(() =>
  Boolean(
    draftProfile.value
      && selectedModelName.value
      && isDirty.value
      && draftBaseRevision.value !== null
      && !pendingSave.value,
  ),
);
const profileBadge = computed(() => {
  const profile = currentProfile.value;
  if (!profile) {
    return "missing";
  }
  return `rev ${profile.revision}`;
});

watch(
  draftAxes,
  (axes) => {
    if (!axes.length) {
      selectedAxisId.value = "";
      return;
    }
    if (!axes.some((axis) => axis.id === selectedAxisId.value)) {
      selectedAxisId.value = axes[0].id;
    }
  },
  { immediate: true },
);

watch(
  currentProfile,
  (nextProfile) => {
    const pending = pendingSave.value;
    if (
      pending
      && nextProfile
      && nextProfile.revision > pending.expectedRevision
    ) {
      saveStatusText.value = `保存成功，已同步到 revision ${nextProfile.revision}。`;
      pendingSave.value = null;
    }

    if (!nextProfile) {
      draftProfile.value = null;
      draftBaseRevision.value = null;
      selectedAxisId.value = "";
      isDirty.value = false;
      return;
    }

    const shouldReplaceDraft =
      !draftProfile.value
      || !isDirty.value
      || draftProfile.value.model_id !== nextProfile.model_id
      || draftBaseRevision.value !== nextProfile.revision;
    if (!shouldReplaceDraft) {
      return;
    }

    draftProfile.value = cloneSemanticAxisProfile(nextProfile);
    draftBaseRevision.value = nextProfile.revision;
    isDirty.value = false;
  },
  { immediate: true },
);

watch(historyEntries, (entries) => {
  const pending = pendingSave.value;
  if (!pending || !entries.length) {
    return;
  }

  const latestEntry = entries[entries.length - 1];
  if (!isEntryAfter(latestEntry, pending.requestedAtMs)) {
    return;
  }

  if (latestEntry.role === "error") {
    saveStatusText.value = `保存失败：${latestEntry.text}`;
    pendingSave.value = null;
  }
});

function markDirty(): void {
  isDirty.value = true;
  if (!pendingSave.value) {
    saveStatusText.value = "";
  }
}

function resetDraft(): void {
  const profile = currentProfile.value;
  if (!profile) {
    saveStatusText.value = "当前没有可恢复的 semantic_axis_profile。";
    return;
  }
  draftProfile.value = cloneSemanticAxisProfile(profile);
  draftBaseRevision.value = profile.revision;
  isDirty.value = false;
  pendingSave.value = null;
  saveStatusText.value = "已恢复到当前同步版本。";
}

function updateRange(
  axis: SemanticAxisDefinition,
  rangeKey: EditableRangeKey,
  index: 0 | 1,
  event: Event,
): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  const value = Number(target.value);
  if (!Number.isFinite(value)) {
    return;
  }
  axis[rangeKey][index] = value;
  markDirty();
}

function saveProfile(): void {
  const profile = draftProfile.value;
  const expectedRevision = draftBaseRevision.value;
  const modelName = selectedModelName.value;
  if (!profile) {
    saveStatusText.value = "当前没有可保存的 semantic_axis_profile。";
    return;
  }
  if (!modelName) {
    saveStatusText.value = "当前没有已同步模型，无法保存。";
    return;
  }
  if (expectedRevision === null) {
    saveStatusText.value = "当前草稿缺少 revision，无法保存。";
    return;
  }

  pendingSave.value = {
    expectedRevision,
    requestedAtMs: Date.now(),
  };
  saveStatusText.value = `已提交保存请求，等待 revision ${expectedRevision + 1} 的同步结果。`;
  bridge.sendCommand({
    type: "save_semantic_axis_profile",
    modelName,
    expectedRevision,
    profile: cloneSemanticAxisProfile(profile),
  });
}

function formatRange(range: [number, number]): string {
  return `${range[0]} .. ${range[1]}`;
}

function formatBindingTitle(axis: SemanticAxisDefinition): string {
  return `${axis.parameter_bindings.length} bindings`;
}

function isEntryAfter(entry: DesktopHistoryEntry, timestampMs: number): boolean {
  const entryTime = Date.parse(entry.timestamp);
  return Number.isFinite(entryTime) ? entryTime >= timestampMs : true;
}

function cloneSemanticAxisProfile(profile: unknown): SemanticAxisProfile {
  return JSON.parse(JSON.stringify(profile)) as SemanticAxisProfile;
}
</script>

<template>
  <article class="settings-card settings-card--wide profile-editor">
    <div class="settings-card__header">
      <div>
        <p class="settings-card__eyebrow">Profile Editor</p>
        <h2>semantic_axis_profile</h2>
      </div>
      <span class="settings-card__badge">{{ profileBadge }}</span>
    </div>

    <template v-if="currentProfile && draftProfile">
      <div class="profile-editor__meta">
        <span>model {{ selectedModelName || currentProfile.model_id }}</span>
        <span>status {{ currentProfile.status }}</span>
        <span>{{ currentProfile.axes.length }} axes</span>
        <span>{{ currentProfile.couplings.length }} couplings</span>
      </div>

      <p class="settings-card__hint">
        当前只开放 `label`、`control_role`、`description`、`usage_notes`、
        `soft_range`、`strong_range` 编辑；`parameter_bindings` 维持只读展示。
      </p>

      <p v-if="currentProfile.status === 'stale'" class="action-preview__error">
        当前 profile 已标记为 stale。保存仍会走 revision 校验；如果模型文件已经变化，请先重新同步最新 profile。
      </p>

      <div class="profile-editor__layout">
        <aside class="profile-editor__axes">
          <button
            v-for="axis in draftAxes"
            :key="axis.id"
            type="button"
            class="profile-editor__axis-button"
            :data-selected="axis.id === selectedAxis?.id"
            @click="selectedAxisId = axis.id"
          >
            <strong>{{ axis.label }}</strong>
            <span>{{ axis.id }}</span>
            <small>{{ axis.control_role }} · {{ formatBindingTitle(axis) }}</small>
          </button>
        </aside>

        <section v-if="selectedAxis" class="profile-editor__editor">
          <div class="profile-editor__summary">
            <span>{{ selectedAxis.id }}</span>
            <span>{{ selectedAxis.semantic_group }}</span>
            <span>neutral {{ selectedAxis.neutral }}</span>
            <span>value {{ formatRange(selectedAxis.value_range) }}</span>
          </div>

          <div class="profile-editor__form">
            <label class="action-preview__field">
              <span>Axis Label</span>
              <input
                v-model="selectedAxis.label"
                class="settings-card__input"
                type="text"
                @input="markDirty"
              />
            </label>

            <label class="action-preview__field">
              <span>Control Role</span>
              <select
                v-model="selectedAxis.control_role"
                class="settings-card__input action-preview__select"
                @change="markDirty"
              >
                <option
                  v-for="role in CONTROL_ROLE_OPTIONS"
                  :key="role"
                  :value="role"
                >
                  {{ role }}
                </option>
              </select>
            </label>

            <label class="action-preview__field profile-editor__field--full">
              <span>Description</span>
              <textarea
                v-model="selectedAxis.description"
                class="motion-tuning__textarea"
                @input="markDirty"
              />
            </label>

            <label class="action-preview__field profile-editor__field--full">
              <span>Usage Notes</span>
              <textarea
                v-model="selectedAxis.usage_notes"
                class="motion-tuning__textarea"
                @input="markDirty"
              />
            </label>

            <label class="action-preview__field">
              <span>Soft Range</span>
              <div class="profile-editor__range-row">
                <input
                  :value="selectedAxis.soft_range[0]"
                  class="settings-card__input"
                  type="number"
                  step="0.1"
                  @input="updateRange(selectedAxis, 'soft_range', 0, $event)"
                />
                <input
                  :value="selectedAxis.soft_range[1]"
                  class="settings-card__input"
                  type="number"
                  step="0.1"
                  @input="updateRange(selectedAxis, 'soft_range', 1, $event)"
                />
              </div>
            </label>

            <label class="action-preview__field">
              <span>Strong Range</span>
              <div class="profile-editor__range-row">
                <input
                  :value="selectedAxis.strong_range[0]"
                  class="settings-card__input"
                  type="number"
                  step="0.1"
                  @input="updateRange(selectedAxis, 'strong_range', 0, $event)"
                />
                <input
                  :value="selectedAxis.strong_range[1]"
                  class="settings-card__input"
                  type="number"
                  step="0.1"
                  @input="updateRange(selectedAxis, 'strong_range', 1, $event)"
                />
              </div>
            </label>
          </div>

          <section class="profile-editor__readonly">
            <header class="action-preview__group-header">
              <strong>Parameter Bindings</strong>
              <span>read only</span>
            </header>
            <ul class="profile-editor__binding-list">
              <li
                v-for="binding in selectedAxis.parameter_bindings"
                :key="`${selectedAxis.id}:${binding.parameter_id}`"
                class="profile-editor__binding-item"
              >
                <div>
                  <strong>{{ binding.parameter_name || binding.parameter_id }}</strong>
                  <p>{{ binding.parameter_id }}</p>
                </div>
                <div class="profile-editor__binding-metrics">
                  <span>input {{ formatRange(binding.input_range) }}</span>
                  <span>output {{ formatRange(binding.output_range) }}</span>
                  <span>weight {{ binding.default_weight }}</span>
                  <span>invert {{ binding.invert ? "yes" : "no" }}</span>
                </div>
              </li>
            </ul>
          </section>
        </section>
      </div>

      <div class="settings-card__actions">
        <button
          type="button"
          class="settings-card__button"
          :disabled="!canSave"
          @click="saveProfile"
        >
          保存 Profile
        </button>
        <button
          type="button"
          class="settings-card__button settings-card__button--ghost"
          :disabled="!isDirty"
          @click="resetDraft"
        >
          放弃未保存修改
        </button>
        <span class="profile-editor__status">
          {{ saveStatusText || (isDirty ? "存在未保存修改。" : "当前草稿与已同步 profile 一致。") }}
        </span>
      </div>
    </template>

    <p v-else class="history-empty">
      当前模型未下发 `semantic_axis_profile`，Profile Editor 暂不可用。
    </p>
  </article>
</template>
