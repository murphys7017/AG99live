<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useDesktopBridge } from "../composables/useDesktopBridge";
import type { DesktopHistoryEntry } from "../types/desktop";
import type {
  SemanticAxisControlRole,
  SemanticAxisCoupling,
  SemanticAxisDefinition,
  SemanticAxisParameterBinding,
  SemanticAxisProfile,
} from "../types/semantic-axis-profile";

type EditableAxisRangeKey = "value_range" | "soft_range" | "strong_range";
type EditableBindingRangeKey = "input_range" | "output_range";
type EditableSemanticListKey = "positive_semantics" | "negative_semantics";

const CONTROL_ROLE_OPTIONS: SemanticAxisControlRole[] = [
  "primary",
  "hint",
  "derived",
  "runtime",
  "ambient",
  "debug",
];
const COUPLING_MODE_OPTIONS: SemanticAxisCoupling["mode"][] = [
  "same_direction",
  "opposite_direction",
];

const bridge = useDesktopBridge();
const draftProfile = ref<SemanticAxisProfile | null>(null);
const draftBaseRevision = ref<number | null>(null);
const selectedAxisId = ref("");
const isDirty = ref(false);
const saveStatusText = ref("");
const pendingSave = ref<{
  expectedRevision: number;
  modelId: string;
  profileId: string;
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
const draftCouplings = computed(() => draftProfile.value?.couplings ?? []);
const axisOptions = computed(() =>
  draftAxes.value.map((axis) => ({
    id: axis.id,
    label: axis.label || axis.id,
  })),
);
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
      && nextProfile.model_id === pending.modelId
      && nextProfile.profile_id === pending.profileId
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

function createStableId(prefix: string): string {
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${randomPart}`;
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
  targetRangeOwner: Pick<SemanticAxisDefinition, EditableAxisRangeKey>,
  rangeKey: EditableAxisRangeKey,
  index: 0 | 1,
  event: Event,
): void {
  const value = readFiniteNumber(event);
  if (value === null) {
    return;
  }
  targetRangeOwner[rangeKey][index] = value;
  markDirty();
}

function updateBindingRange(
  binding: SemanticAxisParameterBinding,
  rangeKey: EditableBindingRangeKey,
  index: 0 | 1,
  event: Event,
): void {
  const value = readFiniteNumber(event);
  if (value === null) {
    return;
  }
  binding[rangeKey][index] = value;
  markDirty();
}

function updateBindingWeight(binding: SemanticAxisParameterBinding, event: Event): void {
  const value = readFiniteNumber(event);
  if (value === null) {
    return;
  }
  binding.default_weight = value;
  markDirty();
}

function updateCouplingNumber(
  coupling: SemanticAxisCoupling,
  key: "scale" | "deadzone" | "max_delta",
  event: Event,
): void {
  const value = readFiniteNumber(event);
  if (value === null) {
    return;
  }
  coupling[key] = value;
  markDirty();
}

function updateStringListFromText(
  axis: SemanticAxisDefinition,
  key: EditableSemanticListKey,
  event: Event,
): void {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement)) {
    return;
  }
  axis[key] = target.value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  markDirty();
}

function formatStringListInput(values: string[]): string {
  return values.join("\n");
}

function addBinding(axis: SemanticAxisDefinition): void {
  axis.parameter_bindings.push({
    parameter_id: "",
    parameter_name: "",
    input_range: [0, 100],
    output_range: [0, 1],
    default_weight: 1,
    invert: false,
  });
  markDirty();
}

function removeBinding(axis: SemanticAxisDefinition, index: number): void {
  if (axis.parameter_bindings.length <= 1) {
    saveStatusText.value = "每个轴至少需要保留一个 parameter binding。";
    return;
  }
  axis.parameter_bindings.splice(index, 1);
  markDirty();
}

function addCoupling(): void {
  const profile = draftProfile.value;
  const [sourceAxis, targetAxis] = draftAxes.value;
  if (!profile || !sourceAxis || !targetAxis) {
    saveStatusText.value = "至少需要两个轴才能新增 coupling。";
    return;
  }
  profile.couplings.push({
    id: createStableId("coupling"),
    source_axis_id: sourceAxis.id,
    target_axis_id: targetAxis.id,
    mode: "same_direction",
    scale: 0.25,
    deadzone: 4,
    max_delta: 10,
  });
  markDirty();
}

function removeCoupling(index: number): void {
  const profile = draftProfile.value;
  if (!profile) {
    return;
  }
  profile.couplings.splice(index, 1);
  markDirty();
}

function readFiniteNumber(event: Event): number | null {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return null;
  }
  const value = Number(target.value);
  return Number.isFinite(value) ? value : null;
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
    modelId: profile.model_id,
    profileId: profile.profile_id,
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
        当前可编辑轴语义、数值范围、parameter bindings 和 couplings；保存后由后端 schema 做严格校验。
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
              <span>Semantic Group</span>
              <input
                v-model="selectedAxis.semantic_group"
                class="settings-card__input"
                type="text"
                @input="markDirty"
              />
            </label>

            <label class="action-preview__field">
              <span>Neutral</span>
              <input
                v-model.number="selectedAxis.neutral"
                class="settings-card__input"
                type="number"
                step="0.1"
                @input="markDirty"
              />
            </label>

            <label class="action-preview__field">
              <span>Value Range</span>
              <div class="profile-editor__range-row">
                <input
                  :value="selectedAxis.value_range[0]"
                  class="settings-card__input"
                  type="number"
                  step="0.1"
                  @input="updateRange(selectedAxis, 'value_range', 0, $event)"
                />
                <input
                  :value="selectedAxis.value_range[1]"
                  class="settings-card__input"
                  type="number"
                  step="0.1"
                  @input="updateRange(selectedAxis, 'value_range', 1, $event)"
                />
              </div>
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

            <label class="action-preview__field profile-editor__field--full">
              <span>Positive Semantics</span>
              <textarea
                :value="formatStringListInput(selectedAxis.positive_semantics)"
                class="motion-tuning__textarea"
                @input="updateStringListFromText(selectedAxis, 'positive_semantics', $event)"
              />
            </label>

            <label class="action-preview__field profile-editor__field--full">
              <span>Negative Semantics</span>
              <textarea
                :value="formatStringListInput(selectedAxis.negative_semantics)"
                class="motion-tuning__textarea"
                @input="updateStringListFromText(selectedAxis, 'negative_semantics', $event)"
              />
            </label>
          </div>

          <section class="profile-editor__section">
            <header class="action-preview__group-header">
              <strong>Parameter Bindings</strong>
              <button
                type="button"
                class="settings-card__button settings-card__button--ghost"
                @click="addBinding(selectedAxis)"
              >
                新增 Binding
              </button>
            </header>
            <ul class="profile-editor__binding-list">
              <li
                v-for="(binding, bindingIndex) in selectedAxis.parameter_bindings"
                :key="`${selectedAxis.id}:${bindingIndex}:${binding.parameter_id}`"
                class="profile-editor__binding-item"
              >
                <div class="profile-editor__binding-form">
                  <label class="action-preview__field">
                    <span>Parameter ID</span>
                    <input
                      v-model="binding.parameter_id"
                      class="settings-card__input"
                      type="text"
                      @input="markDirty"
                    />
                  </label>
                  <label class="action-preview__field">
                    <span>Parameter Name</span>
                    <input
                      v-model="binding.parameter_name"
                      class="settings-card__input"
                      type="text"
                      @input="markDirty"
                    />
                  </label>
                  <label class="action-preview__field">
                    <span>Input Range</span>
                    <div class="profile-editor__range-row">
                      <input
                        :value="binding.input_range[0]"
                        class="settings-card__input"
                        type="number"
                        step="0.1"
                        @input="updateBindingRange(binding, 'input_range', 0, $event)"
                      />
                      <input
                        :value="binding.input_range[1]"
                        class="settings-card__input"
                        type="number"
                        step="0.1"
                        @input="updateBindingRange(binding, 'input_range', 1, $event)"
                      />
                    </div>
                  </label>
                  <label class="action-preview__field">
                    <span>Output Range</span>
                    <div class="profile-editor__range-row">
                      <input
                        :value="binding.output_range[0]"
                        class="settings-card__input"
                        type="number"
                        step="0.1"
                        @input="updateBindingRange(binding, 'output_range', 0, $event)"
                      />
                      <input
                        :value="binding.output_range[1]"
                        class="settings-card__input"
                        type="number"
                        step="0.1"
                        @input="updateBindingRange(binding, 'output_range', 1, $event)"
                      />
                    </div>
                  </label>
                  <label class="action-preview__field">
                    <span>Weight</span>
                    <input
                      :value="binding.default_weight"
                      class="settings-card__input"
                      type="number"
                      step="0.05"
                      @input="updateBindingWeight(binding, $event)"
                    />
                  </label>
                  <label class="profile-editor__toggle">
                    <input
                      v-model="binding.invert"
                      type="checkbox"
                      @change="markDirty"
                    />
                    <span>invert</span>
                  </label>
                  <button
                    type="button"
                    class="settings-card__button settings-card__button--ghost"
                    @click="removeBinding(selectedAxis, bindingIndex)"
                  >
                    删除 Binding
                  </button>
                </div>
              </li>
            </ul>
          </section>

          <section class="profile-editor__section">
            <header class="action-preview__group-header">
              <strong>Couplings</strong>
              <button
                type="button"
                class="settings-card__button settings-card__button--ghost"
                @click="addCoupling"
              >
                新增 Coupling
              </button>
            </header>
            <ul class="profile-editor__binding-list">
              <li
                v-for="(coupling, couplingIndex) in draftCouplings"
                :key="`${coupling.id}:${couplingIndex}`"
                class="profile-editor__coupling-item"
              >
                <div class="profile-editor__binding-form">
                  <label class="action-preview__field">
                    <span>ID</span>
                    <input
                      v-model="coupling.id"
                      class="settings-card__input"
                      type="text"
                      @input="markDirty"
                    />
                  </label>
                  <label class="action-preview__field">
                    <span>Source Axis</span>
                    <select
                      v-model="coupling.source_axis_id"
                      class="settings-card__input action-preview__select"
                      @change="markDirty"
                    >
                      <option
                        v-for="axis in axisOptions"
                        :key="`source:${coupling.id}:${axis.id}`"
                        :value="axis.id"
                      >
                        {{ axis.label }} / {{ axis.id }}
                      </option>
                    </select>
                  </label>
                  <label class="action-preview__field">
                    <span>Target Axis</span>
                    <select
                      v-model="coupling.target_axis_id"
                      class="settings-card__input action-preview__select"
                      @change="markDirty"
                    >
                      <option
                        v-for="axis in axisOptions"
                        :key="`target:${coupling.id}:${axis.id}`"
                        :value="axis.id"
                      >
                        {{ axis.label }} / {{ axis.id }}
                      </option>
                    </select>
                  </label>
                  <label class="action-preview__field">
                    <span>Mode</span>
                    <select
                      v-model="coupling.mode"
                      class="settings-card__input action-preview__select"
                      @change="markDirty"
                    >
                      <option
                        v-for="mode in COUPLING_MODE_OPTIONS"
                        :key="mode"
                        :value="mode"
                      >
                        {{ mode }}
                      </option>
                    </select>
                  </label>
                  <label class="action-preview__field">
                    <span>Scale</span>
                    <input
                      :value="coupling.scale"
                      class="settings-card__input"
                      type="number"
                      step="0.05"
                      @input="updateCouplingNumber(coupling, 'scale', $event)"
                    />
                  </label>
                  <label class="action-preview__field">
                    <span>Deadzone</span>
                    <input
                      :value="coupling.deadzone"
                      class="settings-card__input"
                      type="number"
                      step="0.1"
                      @input="updateCouplingNumber(coupling, 'deadzone', $event)"
                    />
                  </label>
                  <label class="action-preview__field">
                    <span>Max Delta</span>
                    <input
                      :value="coupling.max_delta"
                      class="settings-card__input"
                      type="number"
                      step="0.1"
                      @input="updateCouplingNumber(coupling, 'max_delta', $event)"
                    />
                  </label>
                  <button
                    type="button"
                    class="settings-card__button settings-card__button--ghost"
                    @click="removeCoupling(couplingIndex)"
                  >
                    删除 Coupling
                  </button>
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
