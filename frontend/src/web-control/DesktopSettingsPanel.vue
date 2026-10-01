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

function onSelect(entry: DesktopSettingEntry, event: Event): void {
  const target = event.target as HTMLSelectElement;
  if (target.value !== entry.value) {
    props.onApply(entry.key, target.value);
  }
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
        这些配置属于桌面端所在的那台电脑，由桌面端自己提供可选值并应用。服务端只负责转发。
      </p>

      <p v-if="!settings.length" class="web-control-empty">暂无桌面端配置项。</p>

      <label v-for="entry in settings" :key="entry.key" class="web-control-field">
        <span class="web-control-field__label">{{ entry.label }}</span>

        <select
          :value="entry.value"
          :disabled="props.busy || !props.connected || !entry.options.length"
          @change="onSelect(entry, $event)"
        >
          <option v-if="!entry.options.length" value="">尚未获取到可选项</option>
          <option
            v-for="option in entry.options"
            :key="option.id"
            :value="option.id"
          >{{ option.label }}</option>
        </select>

        <span class="web-control-field__hint">{{ entry.description }}</span>
        <span v-if="entry.reportedAt" class="web-control-field__hint">
          最后由桌面端上报于 {{ formatReportedAt(entry.reportedAt) }}
        </span>
        <span v-if="!props.connected" class="web-control-field__hint">
          桌面端未连接，以上为最后一次已知的值，当前不可修改。
        </span>
        <span v-if="props.error" class="web-control-field__error" role="alert">
          {{ props.error }}
        </span>
      </label>

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
