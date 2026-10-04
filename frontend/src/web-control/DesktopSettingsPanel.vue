<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { DesktopSettingEntry } from "./desktopSettings";
import { formatReportedAt } from "./desktopSettings";
import { createPttKeyBindingFromKeyboardEvent } from "../adapter-connection/core/pttKeyBinding";

const props = defineProps<{
  settings: DesktopSettingEntry[];
  connected: boolean;
  busy: boolean;
  error: string;
  onRefresh: () => void;
  onApply: (key: string, value: string) => void | Promise<void>;
}>();

const capturingKey = ref<string | null>(null);

function isDisabled(entry: DesktopSettingEntry): boolean {
  return props.busy || !props.connected || !entry.reportedAt;
}

function applyValue(entry: DesktopSettingEntry, value: string): void {
  if (value !== entry.value) {
    void props.onApply(entry.key, value);
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

function onPasswordInput(entry: DesktopSettingEntry, event: Event): void {
  const target = event.target as HTMLInputElement;
  if (!target.value) return;
  void props.onApply(entry.key, target.value);
  target.value = "";
}

function clearPassword(entry: DesktopSettingEntry): void {
  if (entry.value) {
    void props.onApply(entry.key, "");
  }
}

function beginKeyCapture(entry: DesktopSettingEntry): void {
  if (isDisabled(entry)) return;
  capturingKey.value = entry.key;
}

function keyBindingLabel(entry: DesktopSettingEntry): string {
  try {
    const parsed = JSON.parse(entry.value) as { label?: unknown; code?: unknown };
    if (typeof parsed.label === "string" && parsed.label.trim()) return parsed.label;
    if (typeof parsed.code === "string" && parsed.code.trim()) return parsed.code;
  } catch {
    // A malformed value is still shown as text below so the user can recover.
  }
  return entry.value || "未设置";
}

function captureKey(event: KeyboardEvent): void {
  const key = capturingKey.value;
  if (!key) return;
  event.preventDefault();
  event.stopPropagation();
  const entry = props.settings.find((candidate) => candidate.key === key);
  capturingKey.value = null;
  if (!entry || isDisabled(entry)) return;
  // Some browser/webview-generated keyboard events have no physical code
  // (for example an unidentified key). Do not let normalization turn that
  // empty value into the default Ctrl binding.
  if (!event.code.trim()) return;
  const binding = createPttKeyBindingFromKeyboardEvent(event);
  if (binding.code) {
    applyValue(entry, JSON.stringify(binding));
  }
}

function cancelKeyCapture(): void {
  capturingKey.value = null;
}

function formatRangeValue(entry: DesktopSettingEntry): string {
  if (!entry.value) return "—";
  const value = Number(entry.value);
  if (!Number.isFinite(value)) return entry.value;
  if (entry.key === "speech_volume") return `${Math.round(value * 100)}%`;
  if (entry.key === "model_view_scale") return `×${value.toFixed(2)}`;
  return entry.key.includes("crop_") || entry.key.endsWith("jpeg_quality")
    ? `${Math.round(value * 100)}%`
    : entry.value;
}

onMounted(() => window.addEventListener("keydown", captureKey, true));
onBeforeUnmount(() => window.removeEventListener("keydown", captureKey, true));
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

        <div v-else class="web-control-field">
          <label class="web-control-field__label" :for="`desktop-setting-${entry.key}`">{{ entry.label }}</label>

          <input
            v-if="entry.kind === 'text'"
            :id="`desktop-setting-${entry.key}`"
            type="text"
            :value="entry.value"
            :maxlength="255"
            :disabled="isDisabled(entry)"
            @change="onInput(entry, $event)"
          />
          <div v-else-if="entry.kind === 'password'" class="web-control-password-input">
            <input
              :id="`desktop-setting-${entry.key}`"
              type="password"
              value=""
              :placeholder="entry.value ? '已配置，输入新值以替换' : '未配置'"
              autocomplete="new-password"
              :disabled="isDisabled(entry)"
              @change="onPasswordInput(entry, $event)"
            />
            <button
              v-if="entry.value"
              type="button"
              class="web-control-refresh"
              :disabled="isDisabled(entry)"
              @click="clearPassword(entry)"
            >清除</button>
          </div>
          <input
            v-else-if="entry.kind === 'number'"
            :id="`desktop-setting-${entry.key}`"
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
              :id="`desktop-setting-${entry.key}`"
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
          <div v-else-if="entry.kind === 'key'" class="web-control-key-capture">
            <button
              type="button"
              class="web-control-key-capture__button"
              :id="`desktop-setting-${entry.key}`"
              :disabled="isDisabled(entry)"
              @click="beginKeyCapture(entry)"
              @blur="cancelKeyCapture"
            >
              {{ capturingKey === entry.key ? "请按下一个按键" : `当前按键：${keyBindingLabel(entry)}` }}
            </button>
            <span v-if="capturingKey === entry.key" class="web-control-field__hint">
              按下后立即保存；Esc 也会作为有效按键绑定。
            </span>
          </div>
          <select
            v-else
            :id="`desktop-setting-${entry.key}`"
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
        </div>

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
