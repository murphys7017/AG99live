<script setup lang="ts">
import type {
  SemanticAxisCoupling,
  SemanticAxisDefinition,
  SemanticAxisParameterBinding,
} from "../types/semantic-axis-profile";
import {
  CONTROL_ROLE_OPTIONS,
  COUPLING_MODE_OPTIONS,
  PROFILE_BINDING_GUIDE,
  PROFILE_COUPLING_GUIDE,
} from "../data/profileEditorGuide";

type EditableAxisRangeKey = "value_range" | "soft_range" | "strong_range";
type EditableBindingRangeKey = "input_range" | "output_range";

const props = defineProps<{
  axis: SemanticAxisDefinition;
  draftAxes: SemanticAxisDefinition[];
  draftCouplings: SemanticAxisCoupling[];
  customAxisReviewRequiredIds: Set<string>;
}>();

const emit = defineEmits<{
  markDirty: [];
  addCoupling: [];
  removeCoupling: [index: number];
  confirmSelectedAxis: [];
  addBinding: [axis: SemanticAxisDefinition];
  removeBinding: [axis: SemanticAxisDefinition, index: number];
}>();

function readFiniteNumber(event: Event): number | null {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return null;
  }
  const value = Number(target.value);
  return Number.isFinite(value) ? value : null;
}

function updateRange(
  targetRangeOwner: Pick<SemanticAxisDefinition, EditableAxisRangeKey>,
  rangeKey: EditableAxisRangeKey,
  index: 0 | 1,
  event: Event,
): void {
  const value = readFiniteNumber(event);
  if (value === null) return;
  targetRangeOwner[rangeKey][index] = value;
  emit("markDirty");
}

function updateBindingRange(
  binding: SemanticAxisParameterBinding,
  rangeKey: EditableBindingRangeKey,
  index: 0 | 1,
  event: Event,
): void {
  const value = readFiniteNumber(event);
  if (value === null) return;
  binding[rangeKey][index] = value;
  emit("markDirty");
}

function updateBindingWeight(binding: SemanticAxisParameterBinding, event: Event): void {
  const value = readFiniteNumber(event);
  if (value === null) return;
  binding.default_weight = value;
  emit("markDirty");
}

function updateCouplingNumber(
  coupling: SemanticAxisCoupling,
  key: "scale" | "deadzone" | "max_delta",
  event: Event,
): void {
  const value = readFiniteNumber(event);
  if (value === null) return;
  coupling[key] = value;
  emit("markDirty");
}

function updateStringListFromText(
  axis: SemanticAxisDefinition,
  key: "positive_semantics" | "negative_semantics",
  event: Event,
): void {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement)) return;
  axis[key] = target.value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  emit("markDirty");
}

function formatStringListInput(values: string[]): string {
  return values.join("\n");
}

function formatRange(range: [number, number]): string {
  return `${range[0]} .. ${range[1]}`;
}

function formatBindingTitle(axis: SemanticAxisDefinition): string {
  return `${axis.parameter_bindings.length} bindings`;
}

function onAddBinding(): void {
  emit("addBinding", props.axis);
}

function onRemoveBinding(index: number): void {
  emit("removeBinding", props.axis, index);
}
</script>

<template>
  <section class="profile-editor__editor">
    <div class="profile-editor__summary">
      <span>{{ axis.id }}</span>
      <span>{{ axis.semantic_group }}</span>
      <span>neutral {{ axis.neutral }}</span>
      <span>value {{ formatRange(axis.value_range) }}</span>
    </div>

    <div class="profile-editor__help-block profile-editor__help-block--compact">
      <strong>当前 axis 的推荐配置顺序</strong>
      <ul class="profile-editor__help-list">
        <li>先写 `Description / Positive / Negative Semantics`，把这个轴的大方向语义讲清楚。</li>
        <li>再定 `Neutral / Value Range / Soft Range / Strong Range`，决定它的中心点和强弱边界。</li>
        <li>最后配置 `Parameter Bindings`，把这个语义轴映射到真实 Live2D 参数。</li>
      </ul>
    </div>

    <div class="profile-editor__form">
      <label class="action-preview__field">
        <span>Axis Label（显示名）</span>
        <input
          v-model="axis.label"
          class="settings-card__input"
          type="text"
          @input="emit('markDirty')"
        />
      </label>

      <label class="action-preview__field">
        <span>Control Role（控制来源）</span>
        <select
          v-model="axis.control_role"
          class="settings-card__input action-preview__select"
          @change="emit('markDirty')"
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
        <span>Description（给 LLM 的主语义说明）</span>
        <textarea
          v-model="axis.description"
          class="motion-tuning__textarea"
          @input="emit('markDirty')"
        />
      </label>

      <label class="action-preview__field profile-editor__field--full">
        <span>Usage Notes（使用限制 / 习惯）</span>
        <textarea
          v-model="axis.usage_notes"
          class="motion-tuning__textarea"
          @input="emit('markDirty')"
        />
      </label>

      <label class="action-preview__field">
        <span>Semantic Group（分组）</span>
        <input
          v-model="axis.semantic_group"
          class="settings-card__input"
          type="text"
          @input="emit('markDirty')"
        />
      </label>

      <label class="action-preview__field">
        <span>Neutral（静止中心）</span>
        <input
          v-model.number="axis.neutral"
          class="settings-card__input"
          type="number"
          step="0.1"
          @input="emit('markDirty')"
        />
      </label>

      <label class="action-preview__field">
        <span>Value Range（合法总范围）</span>
        <div class="profile-editor__range-row">
          <input
            :value="axis.value_range[0]"
            class="settings-card__input"
            type="number"
            step="0.1"
            @input="updateRange(axis, 'value_range', 0, $event)"
          />
          <input
            :value="axis.value_range[1]"
            class="settings-card__input"
            type="number"
            step="0.1"
            @input="updateRange(axis, 'value_range', 1, $event)"
          />
        </div>
      </label>

      <label class="action-preview__field">
        <span>Soft Range（轻微活动区）</span>
        <div class="profile-editor__range-row">
          <input
            :value="axis.soft_range[0]"
            class="settings-card__input"
            type="number"
            step="0.1"
            @input="updateRange(axis, 'soft_range', 0, $event)"
          />
          <input
            :value="axis.soft_range[1]"
            class="settings-card__input"
            type="number"
            step="0.1"
            @input="updateRange(axis, 'soft_range', 1, $event)"
          />
        </div>
      </label>

      <label class="action-preview__field">
        <span>Strong Range（强表达参考区）</span>
        <div class="profile-editor__range-row">
          <input
            :value="axis.strong_range[0]"
            class="settings-card__input"
            type="number"
            step="0.1"
            @input="updateRange(axis, 'strong_range', 0, $event)"
          />
          <input
            :value="axis.strong_range[1]"
            class="settings-card__input"
            type="number"
            step="0.1"
            @input="updateRange(axis, 'strong_range', 1, $event)"
          />
        </div>
      </label>

      <label class="action-preview__field profile-editor__field--full">
        <span>Positive Semantics（值变大代表什么）</span>
        <textarea
          :value="formatStringListInput(axis.positive_semantics)"
          class="motion-tuning__textarea"
          @input="updateStringListFromText(axis, 'positive_semantics', $event)"
        />
      </label>

      <label class="action-preview__field profile-editor__field--full">
        <span>Negative Semantics（值变小代表什么）</span>
        <textarea
          :value="formatStringListInput(axis.negative_semantics)"
          class="motion-tuning__textarea"
          @input="updateStringListFromText(axis, 'negative_semantics', $event)"
        />
      </label>
    </div>

    <section class="profile-editor__section">
      <header class="action-preview__group-header">
        <strong>Parameter Bindings（映射到真实 Live2D 参数）</strong>
        <div class="profile-editor__header-actions">
          <button
            v-if="customAxisReviewRequiredIds.has(axis.id)"
            type="button"
            class="settings-card__button"
            @click="emit('confirmSelectedAxis')"
          >
            确认当前主轴配置
          </button>
          <button
            type="button"
            class="settings-card__button settings-card__button--ghost"
            @click="onAddBinding"
          >
            新增 Binding
          </button>
        </div>
      </header>
      <div class="profile-editor__help-block profile-editor__help-block--compact">
        <ul class="profile-editor__help-list">
          <li
            v-for="item in PROFILE_BINDING_GUIDE"
            :key="item"
          >
            {{ item }}
          </li>
        </ul>
      </div>
      <ul class="profile-editor__binding-list">
        <li
          v-for="(binding, bindingIndex) in axis.parameter_bindings"
          :key="`${axis.id}:${bindingIndex}:${binding.parameter_id}`"
          class="profile-editor__binding-item"
        >
          <div class="profile-editor__binding-form">
            <label class="action-preview__field">
              <span>Parameter ID（模型参数名）</span>
              <input
                v-model="binding.parameter_id"
                class="settings-card__input"
                type="text"
                @input="emit('markDirty')"
              />
            </label>
            <label class="action-preview__field">
              <span>Parameter Name（备注名）</span>
              <input
                v-model="binding.parameter_name"
                class="settings-card__input"
                type="text"
                @input="emit('markDirty')"
              />
            </label>
            <label class="action-preview__field">
              <span>Input Range（轴值输入区间）</span>
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
              <span>Output Range（参数输出区间）</span>
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
              <span>Weight（默认强度）</span>
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
                @change="emit('markDirty')"
              />
              <span>invert</span>
            </label>
            <button
              type="button"
              class="settings-card__button settings-card__button--ghost"
              @click="onRemoveBinding(bindingIndex)"
            >
              删除 Binding
            </button>
          </div>
        </li>
      </ul>
    </section>

    <section class="profile-editor__section">
      <header class="action-preview__group-header">
        <strong>Couplings（轴间联动）</strong>
        <button
          type="button"
          class="settings-card__button settings-card__button--ghost"
          @click="emit('addCoupling')"
        >
          新增 Coupling
        </button>
      </header>
      <div class="profile-editor__help-block profile-editor__help-block--compact">
        <ul class="profile-editor__help-list">
          <li
            v-for="item in PROFILE_COUPLING_GUIDE"
            :key="item"
          >
            {{ item }}
          </li>
        </ul>
      </div>
      <ul class="profile-editor__binding-list">
        <li
          v-for="(coupling, couplingIndex) in draftCouplings"
          :key="`${coupling.id}:${couplingIndex}`"
          class="profile-editor__coupling-item"
        >
          <div class="profile-editor__binding-form">
            <label class="action-preview__field">
              <span>ID（联动名）</span>
              <input
                v-model="coupling.id"
                class="settings-card__input"
                type="text"
                @input="emit('markDirty')"
              />
            </label>
            <label class="action-preview__field">
              <span>Source Axis（驱动方）</span>
              <select
                v-model="coupling.source_axis_id"
                class="settings-card__input action-preview__select"
                @change="emit('markDirty')"
              >
                <option
                  v-for="ax in draftAxes"
                  :key="`source:${coupling.id}:${ax.id}`"
                  :value="ax.id"
                >
                  {{ ax.label }} / {{ ax.id }}
                </option>
              </select>
            </label>
            <label class="action-preview__field">
              <span>Target Axis（被带动方）</span>
              <select
                v-model="coupling.target_axis_id"
                class="settings-card__input action-preview__select"
                @change="emit('markDirty')"
              >
                <option
                  v-for="ax in draftAxes"
                  :key="`target:${coupling.id}:${ax.id}`"
                  :value="ax.id"
                >
                  {{ ax.label }} / {{ ax.id }}
                </option>
              </select>
            </label>
            <label class="action-preview__field">
              <span>Mode（同向 / 反向）</span>
              <select
                v-model="coupling.mode"
                class="settings-card__input action-preview__select"
                @change="emit('markDirty')"
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
              <span>Scale（跟随比例）</span>
              <input
                :value="coupling.scale"
                class="settings-card__input"
                type="number"
                min="0"
                step="0.05"
                @input="updateCouplingNumber(coupling, 'scale', $event)"
              />
            </label>
            <label class="action-preview__field">
              <span>Deadzone（忽略阈值）</span>
              <input
                :value="coupling.deadzone"
                class="settings-card__input"
                type="number"
                min="0"
                step="0.1"
                @input="updateCouplingNumber(coupling, 'deadzone', $event)"
              />
            </label>
            <label class="action-preview__field">
              <span>Max Delta（最大联动幅度）</span>
              <input
                :value="coupling.max_delta"
                class="settings-card__input"
                type="number"
                min="0"
                step="0.1"
                @input="updateCouplingNumber(coupling, 'max_delta', $event)"
              />
            </label>
            <button
              type="button"
              class="settings-card__button settings-card__button--ghost"
              @click="emit('removeCoupling', couplingIndex)"
            >
              删除 Coupling
            </button>
          </div>
        </li>
      </ul>
    </section>
  </section>
</template>
