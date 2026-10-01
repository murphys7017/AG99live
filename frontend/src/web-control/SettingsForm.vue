<script setup lang="ts">
import type {
  ConfigField,
  ConfigSection,
  ConfigValues,
  ProviderOption,
} from "./configSchema";

const props = defineProps<{
  sections: ConfigSection[];
  values: ConfigValues;
  providers: ProviderOption[];
  models: string[];
  fieldErrorPath: string;
  fieldErrorCode: string;
  disabled: boolean;
  labelFor: (field: ConfigField) => string;
  descriptionFor: (field: ConfigField) => string;
  message: (key: string, fallback: string) => string;
}>();

const emit = defineEmits<{
  (event: "change", path: string, value: string | number | boolean): void;
}>();

function valueAt(field: ConfigField, sectionKey: string): string | number | boolean {
  const stored = props.values[sectionKey]?.[field.key];
  if (typeof stored === "boolean" || typeof stored === "number" || typeof stored === "string") {
    return stored;
  }
  if (field.kind === "bool") return false;
  if (field.kind === "int" || field.kind === "float") return 0;
  return "";
}

/**
 * Mirrors the backend rules so the user sees the problem before a round trip.
 * The backend stays the authority; this only decides what to mark inline.
 */
function localError(field: ConfigField, sectionKey: string): string {
  const path = `${sectionKey}.${field.key}`;
  if (props.fieldErrorPath === path) {
    return props.message(`errors.${props.fieldErrorCode}`, "");
  }
  const value = valueAt(field, sectionKey);
  if (field.kind === "text" || field.kind === "model" || field.kind === "provider") {
    const text = String(value).trim();
    if (field.required && !text) return props.message("errors.settings_value_required", "");
    if (field.maxLength !== undefined && text.length > field.maxLength) {
      return props.message("errors.settings_value_too_long", "");
    }
    return "";
  }
  if (field.kind === "int" || field.kind === "float") {
    const numeric = Number(value);
    if (String(value).trim() === "" || !Number.isFinite(numeric)) {
      return props.message("errors.settings_value_invalid", "");
    }
    if (field.minimum !== undefined && numeric < field.minimum) {
      return props.message("errors.settings_value_out_of_range", "");
    }
    if (field.maximum !== undefined && numeric > field.maximum) {
      return props.message("errors.settings_value_out_of_range", "");
    }
  }
  return "";
}

function rangeHint(field: ConfigField): string {
  if (field.minimum === undefined || field.maximum === undefined) return "";
  return `${field.minimum} – ${field.maximum}`;
}

function onInput(field: ConfigField, sectionKey: string, event: Event): void {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  const path = `${sectionKey}.${field.key}`;
  if (field.kind === "bool") {
    emit("change", path, (target as HTMLInputElement).checked);
    return;
  }
  if (field.kind === "int" || field.kind === "float") {
    if (target.value === "") {
      emit("change", path, "");
      return;
    }
    const numeric = Number(target.value);
    emit("change", path, Number.isFinite(numeric) ? numeric : target.value);
    return;
  }
  emit("change", path, target.value);
}
</script>

<template>
  <div class="web-control-settings-grid">
    <section v-for="section in sections" :key="section.key" class="web-control-settings-group">
      <header>
        <h2>{{ section.label }}</h2>
        <span>{{ section.key.toUpperCase() }}</span>
      </header>
      <p class="web-control-settings-group__description">{{ section.description }}</p>

      <template v-for="field in section.fields" :key="field.key">
        <label v-if="field.kind === 'bool'" class="web-control-checkbox">
          <input
            :checked="Boolean(valueAt(field, section.key))"
            type="checkbox"
            :disabled="props.disabled"
            @change="onInput(field, section.key, $event)"
          />
          <span class="web-control-checkbox__copy">
            <strong>{{ labelFor(field) }}</strong>
            <small>{{ descriptionFor(field) }}</small>
          </span>
        </label>

        <label v-else class="web-control-field">
          <span class="web-control-field__label">{{ labelFor(field) }}</span>

          <input
            v-if="field.kind === 'text'"
            :value="String(valueAt(field, section.key))"
            type="text"
            :maxlength="field.maxLength"
            :disabled="props.disabled"
            @input="onInput(field, section.key, $event)"
          />

          <input
            v-else-if="field.kind === 'int' || field.kind === 'float'"
            :value="valueAt(field, section.key)"
            type="number"
            :min="field.minimum"
            :max="field.maximum"
            :step="field.step ?? (field.kind === 'int' ? 1 : 0.01)"
            :disabled="props.disabled"
            @input="onInput(field, section.key, $event)"
          />

          <select
            v-else-if="field.kind === 'model'"
            :value="String(valueAt(field, section.key))"
            :disabled="props.disabled"
            @change="onInput(field, section.key, $event)"
          >
            <option value="">自动选择</option>
            <option v-for="name in models" :key="name" :value="name">{{ name }}</option>
          </select>

          <select
            v-else-if="field.kind === 'provider'"
            :value="String(valueAt(field, section.key))"
            :disabled="props.disabled"
            @change="onInput(field, section.key, $event)"
          >
            <option value="">未选择</option>
            <option v-for="option in providers" :key="option.id" :value="option.id">
              {{ option.id }}<template v-if="option.model"> — {{ option.model }}</template>
            </option>
          </select>

          <span v-if="rangeHint(field)" class="web-control-field__hint">允许范围 {{ rangeHint(field) }}</span>
          <span class="web-control-field__hint">{{ descriptionFor(field) }}</span>
          <span v-if="localError(field, section.key)" class="web-control-field__error" role="alert">
            {{ localError(field, section.key) }}
          </span>
        </label>
      </template>
    </section>
  </div>
</template>
