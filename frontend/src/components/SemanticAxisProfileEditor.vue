<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useDesktopBridge } from "../composables/useDesktopBridge";
import type {
  SemanticAxisControlRole,
  SemanticAxisCoupling,
  SemanticAxisDefinition,
  SemanticAxisProfile,
} from "../types/semantic-axis-profile";
import { useParameterExcludeKeywords } from "../composables/useParameterExcludeKeywords";
import { CONTROL_ROLE_OPTIONS } from "../data/profileEditorGuide";
import ProfileGuideHelp from "./ProfileGuideHelp.vue";
import AxisDetailForm from "./AxisDetailForm.vue";

type AxisRoleFilter = SemanticAxisControlRole | "all";

const bridge = useDesktopBridge();
const draftProfile = ref<SemanticAxisProfile | null>(null);
const draftBaseRevision = ref<number | null>(null);
const selectedAxisId = ref("");
const selectedAxisIds = ref<string[]>([]);
const axisRoleFilter = ref<AxisRoleFilter>("all");
const axisSearchText = ref("");
const batchTargetRole = ref<SemanticAxisControlRole>("primary");
const customAxisReviewRequiredIds = ref<Set<string>>(new Set());
const isDirty = ref(false);
const hasExternalRevisionConflict = ref(false);
const saveStatusText = ref("");
const pendingSave = ref<{
  requestId: string;
  expectedRevision: number;
  modelId: string;
  profileId: string;
} | null>(null);

const currentProfile = computed(
  () => bridge.state.snapshot.runtimeSemanticAxisProfile,
);
const selectedModelName = computed(() =>
  bridge.state.snapshot.selectedModelName.trim(),
);
const latestSaveResult = computed(() =>
  bridge.state.profileAuthoringSnapshot.latestSemanticAxisProfileSaveResult,
);
const draftAxes = computed(() => draftProfile.value?.axes ?? []);
const draftCouplings = computed(() => draftProfile.value?.couplings ?? []);
const filteredAxes = computed(() => {
  const roleFilter = axisRoleFilter.value;
  const query = axisSearchText.value.trim().toLowerCase();
  const excludedKeywords = parameterExcludeKeywords.value;
  return draftAxes.value.filter((axis) => {
    if (roleFilter !== "all" && axis.control_role !== roleFilter) {
      return false;
    }
    if (axisMatchesExcludedParameterKeyword(axis, excludedKeywords)) {
      return false;
    }
    if (!query) {
      return true;
    }
    return axisMatchesSearch(axis, query);
  });
});
const {
  excludedParameterKeywordsText,
  parameterExcludeKeywords,
  persistParameterExcludeKeywords,
  resetParameterExcludeKeywords,
} = useParameterExcludeKeywords();
const excludedAxisCount = computed(() =>
  draftAxes.value.filter((axis) =>
    axisMatchesExcludedParameterKeyword(axis, parameterExcludeKeywords.value),
  ).length,
);
const filteredAxisIds = computed(() => filteredAxes.value.map((axis) => axis.id));
const selectedAxisCount = computed(() => selectedAxisIds.value.length);
const allFilteredAxesSelected = computed(() => {
  const ids = filteredAxisIds.value;
  return ids.length > 0 && ids.every((id) => selectedAxisIds.value.includes(id));
});
const selectedAxis = computed<SemanticAxisDefinition | null>(() => {
  const axes = draftAxes.value;
  if (!axes.length) {
    return null;
  }
  return axes.find((axis) => axis.id === selectedAxisId.value) ?? axes[0] ?? null;
});
const selectedAxisMatchesCurrentFilter = computed(() =>
  Boolean(
    selectedAxis.value
      && filteredAxisIds.value.includes(selectedAxis.value.id),
  ),
);
const draftValidationErrors = computed(() =>
  draftProfile.value ? validateDraftProfile(draftProfile.value) : [],
);
const canSave = computed(() =>
  Boolean(
    draftProfile.value
      && selectedModelName.value
      && isDirty.value
      && draftBaseRevision.value !== null
      && draftValidationErrors.value.length === 0
      && !hasExternalRevisionConflict.value
      && !pendingSave.value,
  ),
);
const canApplyBatchRole = computed(() =>
  Boolean(draftProfile.value && selectedAxisIds.value.length),
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
      selectedAxisIds.value = [];
      return;
    }
    const knownAxisIds = new Set(axes.map((axis) => axis.id));
    selectedAxisIds.value = selectedAxisIds.value.filter((id) =>
      knownAxisIds.has(id),
    );
    if (!axes.some((axis) => axis.id === selectedAxisId.value)) {
      selectedAxisId.value = axes[0].id;
    }
  },
  { immediate: true },
);

watch(
  currentProfile,
  (nextProfile) => {
    if (!nextProfile) {
      draftProfile.value = null;
      draftBaseRevision.value = null;
      selectedAxisId.value = "";
      selectedAxisIds.value = [];
      customAxisReviewRequiredIds.value = new Set();
      isDirty.value = false;
      hasExternalRevisionConflict.value = false;
      return;
    }

    if (
      draftProfile.value
      && isDirty.value
      && draftProfile.value.model_id === nextProfile.model_id
      && draftBaseRevision.value !== nextProfile.revision
    ) {
      hasExternalRevisionConflict.value = true;
      saveStatusText.value =
        `后端 profile 已更新到 revision ${nextProfile.revision}。当前草稿基于 revision ${draftBaseRevision.value}，请放弃未保存修改后重新编辑。`;
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
    selectedAxisIds.value = [];
    customAxisReviewRequiredIds.value = new Set();
    isDirty.value = false;
    hasExternalRevisionConflict.value = false;
  },
  { immediate: true },
);

watch(latestSaveResult, (result) => {
  const pending = pendingSave.value;
  if (!pending || !result || result.requestId !== pending.requestId) {
    return;
  }

  if (result.ok) {
    saveStatusText.value = `保存成功，已同步到 revision ${result.revision ?? pending.expectedRevision + 1}。`;
    pendingSave.value = null;
    isDirty.value = false;
    hasExternalRevisionConflict.value = false;
    return;
  }

  if (!result.ok) {
    saveStatusText.value = `保存失败（${result.errorCode || "unknown"}）：${result.message || "后端拒绝保存请求。"}`;
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

function axisMatchesSearch(axis: SemanticAxisDefinition, query: string): boolean {
  const searchableText = [
    axis.id,
    axis.label,
    axis.description,
    axis.semantic_group,
    axis.control_role,
    axis.usage_notes,
    ...axis.positive_semantics,
    ...axis.negative_semantics,
    ...axis.parameter_bindings.flatMap((binding) => [
      binding.parameter_id,
      binding.parameter_name ?? "",
    ]),
  ].join(" ").toLowerCase();
  return searchableText.includes(query);
}

function axisMatchesExcludedParameterKeyword(
  axis: SemanticAxisDefinition,
  keywords: string[],
): boolean {
  if (!keywords.length) {
    return false;
  }
  const haystack = [
    axis.id,
    axis.label,
    axis.description,
    axis.semantic_group,
    axis.usage_notes,
    ...axis.parameter_bindings.flatMap((binding) => [
      binding.parameter_id,
      binding.parameter_name ?? "",
    ]),
  ].join(" ").toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword));
}

function resetDraft(): void {
  const profile = currentProfile.value;
  if (!profile) {
    saveStatusText.value = "当前没有可恢复的 semantic_axis_profile。";
    return;
  }
  draftProfile.value = cloneSemanticAxisProfile(profile);
  draftBaseRevision.value = profile.revision;
  selectedAxisIds.value = [];
  customAxisReviewRequiredIds.value = new Set();
  isDirty.value = false;
  hasExternalRevisionConflict.value = false;
  pendingSave.value = null;
  saveStatusText.value = "已恢复到当前同步版本。";
}

function toggleAxisSelection(axisId: string): void {
  if (selectedAxisIds.value.includes(axisId)) {
    selectedAxisIds.value = selectedAxisIds.value.filter((id) => id !== axisId);
    return;
  }
  selectedAxisIds.value = [...selectedAxisIds.value, axisId];
}

function setFilteredSelection(checked: boolean): void {
  const visibleIds = filteredAxisIds.value;
  if (!checked) {
    const visibleIdSet = new Set(visibleIds);
    selectedAxisIds.value = selectedAxisIds.value.filter((id) =>
      !visibleIdSet.has(id),
    );
    return;
  }
  const nextIds = new Set(selectedAxisIds.value);
  for (const id of visibleIds) {
    nextIds.add(id);
  }
  selectedAxisIds.value = Array.from(nextIds);
}

function applyBatchRole(): void {
  const profile = draftProfile.value;
  if (!profile) {
    saveStatusText.value = "当前没有可编辑的 semantic_axis_profile。";
    return;
  }
  if (!selectedAxisIds.value.length) {
    saveStatusText.value = "请先勾选需要批量处理的 axes。";
    return;
  }

  const selectedIdSet = new Set(selectedAxisIds.value);
  for (const axis of profile.axes) {
    if (selectedIdSet.has(axis.id)) {
      axis.control_role = batchTargetRole.value;
    }
  }
  markDirty();
  saveStatusText.value = `已将 ${selectedIdSet.size} 个 axes 批量设置为 ${batchTargetRole.value}。`;
}

function addCustomAxis(): void {
  const profile = draftProfile.value;
  if (!profile) {
    saveStatusText.value = "当前没有可编辑的 semantic_axis_profile。";
    return;
  }

  const axisId = createStableId("custom_axis");
  const axis: SemanticAxisDefinition = {
    id: axisId,
    label: "New Semantic Axis",
    description: "",
    semantic_group: "custom",
    control_role: "primary",
    neutral: 50,
    value_range: [0, 100],
    soft_range: [35, 65],
    strong_range: [15, 85],
    positive_semantics: [],
    negative_semantics: [],
    usage_notes: "",
    parameter_bindings: [
      {
        parameter_id: "",
        parameter_name: "",
        input_range: [0, 100],
        output_range: [0, 1],
        default_weight: 1,
        invert: false,
      },
    ],
  };
  profile.axes.push(axis);
  selectedAxisId.value = axisId;
  selectedAxisIds.value = [axisId];
  customAxisReviewRequiredIds.value = new Set([
    ...customAxisReviewRequiredIds.value,
    axisId,
  ]);
  markDirty();
  saveStatusText.value = "已新增主轴草稿。保存前请补齐所有必填字段，并显式确认当前轴配置。";
}

function confirmSelectedAxisConfiguration(): void {
  const axis = selectedAxis.value;
  if (!axis) {
    saveStatusText.value = "当前没有可确认的 axis。";
    return;
  }

  const nextIds = new Set(customAxisReviewRequiredIds.value);
  if (!nextIds.delete(axis.id)) {
    saveStatusText.value = `Axis ${axis.id} 当前不需要额外确认。`;
    return;
  }
  customAxisReviewRequiredIds.value = nextIds;
  markDirty();
  saveStatusText.value = `已确认 ${axis.id} 的当前配置。`;
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
  if (hasExternalRevisionConflict.value) {
    saveStatusText.value = "后端 profile revision 已变化。请先放弃未保存修改并重新载入最新 profile。";
    return;
  }
  const validationErrors = validateDraftProfile(profile);
  if (validationErrors.length) {
    saveStatusText.value = `保存前请修复 ${validationErrors.length} 个 profile 问题。`;
    return;
  }

  const requestId = createStableId("semantic_profile_save");
  pendingSave.value = {
    requestId,
    expectedRevision,
    modelId: profile.model_id,
    profileId: profile.profile_id,
  };
  saveStatusText.value = `已提交保存请求，等待 revision ${expectedRevision + 1} 的同步结果。`;
  bridge.sendProfileAuthoringCommand({
    type: "save_semantic_axis_profile",
    requestId,
    modelName,
    profileId: profile.profile_id,
    expectedRevision,
    profile: cloneSemanticAxisProfile(profile),
  });
}

function formatBindingTitle(axis: SemanticAxisDefinition): string {
  return `${axis.parameter_bindings.length} bindings`;
}

function cloneSemanticAxisProfile(profile: unknown): SemanticAxisProfile {
  return JSON.parse(JSON.stringify(profile)) as SemanticAxisProfile;
}

function validateDraftProfile(profile: SemanticAxisProfile): string[] {
  const errors: string[] = [];
  const axisIds = new Set<string>();
  const axisIdPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
  const globalBindingOwners = new Map<string, string>();

  if (!profile.axes.length) {
    errors.push("profile.axes 不能为空。");
  }

  for (const axis of profile.axes) {
    const axisLabel = axis.id || "<empty-axis-id>";
    if (!axis.id.trim()) {
      errors.push("axis.id 不能为空。");
    } else if (!axisIdPattern.test(axis.id)) {
      errors.push(`${axisLabel}: axis.id 必须匹配 ${axisIdPattern.source}。`);
    }
    if (axisIds.has(axis.id)) {
      errors.push(`${axisLabel}: axis.id 重复。`);
    }
    axisIds.add(axis.id);

    if (!axis.label.trim()) {
      errors.push(`${axisLabel}: label 不能为空。`);
    }
    if (!axis.description.trim()) {
      errors.push(`${axisLabel}: description 不能为空。`);
    }
    if (!axis.semantic_group.trim()) {
      errors.push(`${axisLabel}: semantic_group 不能为空。`);
    }
    if (!axis.usage_notes.trim()) {
      errors.push(`${axisLabel}: usage_notes 不能为空。`);
    }
    if (!axis.positive_semantics.length) {
      errors.push(`${axisLabel}: positive_semantics 至少需要一条。`);
    }
    if (!axis.negative_semantics.length) {
      errors.push(`${axisLabel}: negative_semantics 至少需要一条。`);
    }

    validateRange(errors, `${axisLabel}.value_range`, axis.value_range);
    validateRange(errors, `${axisLabel}.soft_range`, axis.soft_range);
    validateRange(errors, `${axisLabel}.strong_range`, axis.strong_range);
    validateFinite(errors, `${axisLabel}.neutral`, axis.neutral);
    if (
      isValidRange(axis.value_range)
      && Number.isFinite(axis.neutral)
      && (axis.neutral < axis.value_range[0] || axis.neutral > axis.value_range[1])
    ) {
      errors.push(`${axisLabel}: neutral 必须位于 value_range 内。`);
    }
    validateContainedRange(errors, `${axisLabel}.soft_range`, axis.soft_range, axis.value_range);
    validateContainedRange(errors, `${axisLabel}.strong_range`, axis.strong_range, axis.value_range);

    if (!axis.parameter_bindings.length) {
      errors.push(`${axisLabel}: parameter_bindings 至少需要一条。`);
    }
    const bindingParameterIds = new Set<string>();
    axis.parameter_bindings.forEach((binding, bindingIndex) => {
      const bindingLabel = `${axisLabel}.parameter_bindings[${bindingIndex}]`;
      const parameterId = binding.parameter_id.trim();
      if (!parameterId) {
        errors.push(`${bindingLabel}: parameter_id 不能为空。`);
      }
      if (bindingParameterIds.has(parameterId)) {
        errors.push(`${bindingLabel}: parameter_id 重复。`);
      }
      bindingParameterIds.add(parameterId);
      if (parameterId) {
        const existingOwner = globalBindingOwners.get(parameterId);
        if (existingOwner && existingOwner !== axisLabel) {
          errors.push(
            `${bindingLabel}: parameter_id 与 ${existingOwner} 重复，跨轴不能复用同一 Live2D parameter。`,
          );
        } else {
          globalBindingOwners.set(parameterId, axisLabel);
        }
      }
      validateRange(errors, `${bindingLabel}.input_range`, binding.input_range);
      validateRange(errors, `${bindingLabel}.output_range`, binding.output_range);
      validateUnitInterval(errors, `${bindingLabel}.default_weight`, binding.default_weight);
    });
  }

  for (const axisId of customAxisReviewRequiredIds.value) {
    if (axisIds.has(axisId)) {
      errors.push(`${axisId}: 新建主轴草稿必须先显式确认当前轴配置。`);
    }
  }

  const couplingIds = new Set<string>();
  const couplingEdges = new Map<string, string[]>();
  const couplingTargets = new Map<string, string>();
  for (const coupling of profile.couplings) {
    const couplingLabel = coupling.id || "<empty-coupling-id>";
    if (!coupling.id.trim()) {
      errors.push("coupling.id 不能为空。");
    }
    if (couplingIds.has(coupling.id)) {
      errors.push(`${couplingLabel}: coupling.id 重复。`);
    }
    couplingIds.add(coupling.id);
    if (!axisIds.has(coupling.source_axis_id)) {
      errors.push(`${couplingLabel}: source_axis_id 不存在。`);
    }
    if (!axisIds.has(coupling.target_axis_id)) {
      errors.push(`${couplingLabel}: target_axis_id 不存在。`);
    }
    if (coupling.source_axis_id === coupling.target_axis_id) {
      errors.push(`${couplingLabel}: source_axis_id 不能等于 target_axis_id。`);
    }
    if (coupling.target_axis_id.trim()) {
      const existingOwner = couplingTargets.get(coupling.target_axis_id);
      if (existingOwner && existingOwner !== couplingLabel) {
        errors.push(
          `${couplingLabel}: target_axis_id 与 ${existingOwner} 重复。当前实现不允许多个 coupling 指向同一 target axis。`,
        );
      } else {
        couplingTargets.set(coupling.target_axis_id, couplingLabel);
      }
    }
    validateNonNegativeFinite(errors, `${couplingLabel}.scale`, coupling.scale);
    validateNonNegativeFinite(errors, `${couplingLabel}.deadzone`, coupling.deadzone);
    validateNonNegativeFinite(errors, `${couplingLabel}.max_delta`, coupling.max_delta);
    if (axisIds.has(coupling.source_axis_id) && axisIds.has(coupling.target_axis_id)) {
      const nextTargets = couplingEdges.get(coupling.source_axis_id) ?? [];
      nextTargets.push(coupling.target_axis_id);
      couplingEdges.set(coupling.source_axis_id, nextTargets);
    }
  }
  const cyclePath = findCouplingCycle(couplingEdges);
  if (cyclePath) {
    errors.push(`couplings 不能形成环：${cyclePath.join(" -> ")}。`);
  }

  return errors;
}

function validateFinite(errors: string[], label: string, value: number): void {
  if (!Number.isFinite(value)) {
    errors.push(`${label} 必须是有限数字。`);
  }
}

function validateNonNegativeFinite(errors: string[], label: string, value: number): void {
  validateFinite(errors, label, value);
  if (Number.isFinite(value) && value < 0) {
    errors.push(`${label} 不能为负数。`);
  }
}

function validateUnitInterval(errors: string[], label: string, value: number): void {
  validateFinite(errors, label, value);
  if (Number.isFinite(value) && (value < 0 || value > 1)) {
    errors.push(`${label} 必须位于 0..1 之间。`);
  }
}

function validateRange(errors: string[], label: string, range: [number, number]): void {
  validateFinite(errors, `${label}[0]`, range[0]);
  validateFinite(errors, `${label}[1]`, range[1]);
  if (Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[0] > range[1]) {
    errors.push(`${label} 的最小值不能大于最大值。`);
  }
}

function validateContainedRange(
  errors: string[],
  label: string,
  range: [number, number],
  container: [number, number],
): void {
  if (!isValidRange(range) || !isValidRange(container)) {
    return;
  }
  if (range[0] < container[0] || range[1] > container[1]) {
    errors.push(`${label} 必须包含在 value_range 内。`);
  }
}

function isValidRange(range: [number, number]): boolean {
  return Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[0] <= range[1];
}

function findCouplingCycle(edges: Map<string, string[]>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  function visit(axisId: string): string[] | null {
    if (visited.has(axisId)) {
      return null;
    }
    if (visiting.has(axisId)) {
      const cycleStart = path.indexOf(axisId);
      return [...path.slice(cycleStart >= 0 ? cycleStart : 0), axisId];
    }
    visiting.add(axisId);
    path.push(axisId);
    for (const nextAxisId of edges.get(axisId) ?? []) {
      const cycle = visit(nextAxisId);
      if (cycle) {
        return cycle;
      }
    }
    path.pop();
    visiting.delete(axisId);
    visited.add(axisId);
    return null;
  }

  for (const axisId of edges.keys()) {
    const cycle = visit(axisId);
    if (cycle) {
      return cycle;
    }
  }
  return null;
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
        当前可编辑轴语义、数值范围、parameter bindings 和 couplings；前端保存前会列出配置错误，后端 schema 仍是最终严格校验。
      </p>

      <ProfileGuideHelp />

      <p v-if="currentProfile.status === 'stale'" class="action-preview__error">
        当前 profile 已标记为 stale。保存仍会走 revision 校验；如果模型文件已经变化，请先重新同步最新 profile。
      </p>

      <div v-if="draftValidationErrors.length" class="profile-editor__validation">
        <strong>保存前必须修复：</strong>
        <ul>
          <li
            v-for="error in draftValidationErrors"
            :key="error"
          >
            {{ error }}
          </li>
        </ul>
      </div>

      <div class="profile-editor__layout">
        <aside class="profile-editor__axes">
          <div class="profile-editor__axis-tools">
            <label class="action-preview__field">
              <span>Filter Text</span>
              <input
                v-model="axisSearchText"
                class="settings-card__input"
                type="search"
                placeholder="axis / parameter / semantics"
              />
            </label>

            <label class="action-preview__field">
              <span>Filter Role</span>
              <select
                v-model="axisRoleFilter"
                class="settings-card__input action-preview__select"
              >
                <option value="all">all</option>
                <option
                  v-for="role in CONTROL_ROLE_OPTIONS"
                  :key="`filter:${role}`"
                  :value="role"
                >
                  {{ role }}
                </option>
              </select>
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
            <div class="profile-editor__bulk-row">
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
            </div>
            <p class="settings-card__hint">
              已隐藏 {{ excludedAxisCount }} 个匹配 hair / bind / physics 等关键词的参数轴。
            </p>

            <div class="profile-editor__bulk-row">
              <button
                type="button"
                class="settings-card__button settings-card__button--ghost"
                :disabled="!filteredAxisIds.length"
                @click="setFilteredSelection(!allFilteredAxesSelected)"
              >
                {{ allFilteredAxesSelected ? "取消当前筛选" : "勾选当前筛选" }}
              </button>
              <span>{{ selectedAxisCount }} selected</span>
            </div>

            <div class="profile-editor__bulk-row">
              <select
                v-model="batchTargetRole"
                class="settings-card__input action-preview__select"
              >
                <option
                  v-for="role in CONTROL_ROLE_OPTIONS"
                  :key="`batch:${role}`"
                  :value="role"
                >
                  {{ role }}
                </option>
              </select>
              <button
                type="button"
                class="settings-card__button"
                :disabled="!canApplyBatchRole"
                @click="applyBatchRole"
              >
                批量设置角色
              </button>
            </div>

            <button
              type="button"
              class="settings-card__button settings-card__button--ghost"
              @click="addCustomAxis"
            >
              新建主轴草稿
            </button>
          </div>

          <p v-if="!filteredAxes.length" class="history-empty">
            当前筛选没有匹配的 axes。
          </p>

          <div
            v-for="axis in filteredAxes"
            :key="axis.id"
            class="profile-editor__axis-row"
            :data-selected="axis.id === selectedAxis?.id"
          >
            <label class="profile-editor__axis-check">
              <input
                type="checkbox"
                :checked="selectedAxisIds.includes(axis.id)"
                :aria-label="`select ${axis.id}`"
                @change="toggleAxisSelection(axis.id)"
              />
            </label>
            <button
              type="button"
              class="profile-editor__axis-button"
              @click="selectedAxisId = axis.id"
            >
              <strong>{{ axis.label }}</strong>
              <span>{{ axis.id }}</span>
              <small>{{ axis.control_role }} · {{ formatBindingTitle(axis) }}</small>
            </button>
          </div>
        </aside>

        <template v-if="selectedAxis">
          <p
            v-if="!selectedAxisMatchesCurrentFilter"
            class="action-preview__error"
          >
            当前正在编辑的 axis 不匹配左侧筛选条件；清空筛选或选择左侧可见 axis 可避免误编辑。
          </p>
          <AxisDetailForm
            :axis="selectedAxis"
            :draft-axes="draftAxes"
            :draft-couplings="draftCouplings"
            :custom-axis-review-required-ids="customAxisReviewRequiredIds"
            @mark-dirty="markDirty"
            @add-coupling="addCoupling"
            @remove-coupling="removeCoupling"
            @confirm-selected-axis="confirmSelectedAxisConfiguration"
            @add-binding="addBinding"
            @remove-binding="removeBinding"
          />
        </template>
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

<style scoped>
.profile-editor__help {
  display: grid;
  gap: 12px;
  margin: 16px 0;
}

.profile-editor__help-block {
  padding: 12px 14px;
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.18);
}

.profile-editor__help-block--compact {
  margin-bottom: 12px;
}

.profile-editor__help-block strong {
  display: block;
  margin-bottom: 8px;
}

.profile-editor__help-list {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 6px;
}
</style>
