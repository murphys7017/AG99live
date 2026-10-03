<script setup lang="ts">
import type { DesktopSettingEntry } from "./desktopSettings";
import { formatReportedAt } from "./desktopSettings";

const props = defineProps<{
  settings: DesktopSettingEntry[];
  connected: boolean;
  busy: boolean;
  error: string;
  onRefresh: () => void;
  onApply: (key: string, value: string) => void;
}>();

function isDisabled(entry: DesktopSettingEntry): boolean {
  return props.busy || !props.connected || !entry.reportedAt;
}

function applyValue(entry: DesktopSettingEntry, value: string): void {
  if (value !== entry.value) {
    props.onApply(entry.key, value);
  }
}

function onToggle(entry: DesktopSettingEntry, event: Event): void {
  const target = event.target as HTMLInputElement;
  applyValue(entry, String(target.checked));
}

function onInput(entry: DesktopSettingEntry, event: Event): void {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  applyValue(entry, target.value);
}

function formatRangeValue(entry: DesktopSettingEntry): string {
  if (!entry.value) return "—";
  const value = Number(entry.value);
  if (!Number.isFinite(value)) return entry.value;
  return entry.key.includes("crop_") || entry.key.endsWith("jpeg_quality")
    ? `${Math.round(value * 100)}%`
    : entry.value;
}
</script>

<template>
  <div class="web-control-settings-grid">
    <section class="web-control-settings-group">
      <header>
        <h2>桌面端本机配置</h2>
        <span>DESKTOP</span>
      </header>
      <p class="web-control-settings-group__description">
        设置由桌面端应用并保存；此页面只通过已连接的桌面端转发修改。
      </p>
      <p v-if="props.error" class="web-control-field__error" role="alert">
        {{ props.error }}
      </p>

      <p v-if="!settings.length" class="web-control-empty">暂无桌面端配置项。</p>

      <template v-for="entry in settings" :key="entry.key">
        <label v-if="entry.kind === 'toggle'" class="web-control-checkbox">
          <input
            type="checkbox"
            :checked="entry.value === 'true'"
            :disabled="isDisabled(entry)"
            @change="onToggle(entry, $event)"
          />
          <span class="web-control-checkbox__copy">
            <strong>{{ entry.label }}</strong>
            <small>{{ entry.description }}</small>
          </span>
        </label>

        <label v-else class="web-control-field">
          <span class="web-control-field__label">{{ entry.label }}</span>

          <input
            v-if="entry.kind === 'text'"
            type="text"
            :value="entry.value"
            :maxlength="255"
            :disabled="isDisabled(entry)"
            @change="onInput(entry, $event)"
          />
          <input
            v-else-if="entry.kind === 'number'"
            type="number"
            :value="entry.value"
            :min="entry.minimum"
            :max="entry.maximum"
            :step="entry.step"
            :disabled="isDisabled(entry)"
            @change="onInput(entry, $event)"
          />
          <div v-else-if="entry.kind === 'range'" class="web-control-range">
            <input
              type="range"
              :value="entry.value"
              :min="entry.minimum"
              :max="entry.maximum"
              :step="entry.step"
              :disabled="isDisabled(entry)"
              @change="onInput(entry, $event)"
            />
            <output>{{ formatRangeValue(entry) }}</output>
          </div>
          <select
            v-else
            :value="entry.value"
            :disabled="isDisabled(entry) || !entry.options.length"
            @change="onInput(entry, $event)"
          >
            <option v-if="!entry.options.length" value="">尚未获取到可选项</option>
            <option
              v-for="option in entry.options"
              :key="option.id"
              :value="option.id"
            >{{ option.label }}</option>
          </select>

          <span class="web-control-field__hint">{{ entry.description }}</span>
        </label>

        <span v-if="entry.reportedAt" class="web-control-field__hint">
          {{ entry.label }}：桌面端上报于 {{ formatReportedAt(entry.reportedAt) }}
        </span>
        <span v-else class="web-control-field__hint">
          {{ entry.label }}：尚未收到桌面端的当前值。
        </span>
        <span v-if="!props.connected" class="web-control-field__hint">
          桌面端未连接，以上为最后一次已知的值，当前不可修改。
        </span>
      </template>

      <div class="web-control-form-actions">
        <span class="web-control-form-actions__status">
          {{ props.connected ? "桌面端已连接" : "桌面端未连接" }}
        </span>
        <button
          type="button"
          class="web-control-refresh"
          :disabled="props.busy || !props.connected || !settings.length"
          @click="props.onRefresh()"
        >从桌面端刷新</button>
      </div>
    </section>
  </div>
</template>
