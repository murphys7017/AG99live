<script setup lang="ts">
import { computed, ref } from "vue";
import { useEsp32DisplaySettings } from "./useEsp32DisplaySettings";
import { useEsp32DisplayConnection } from "./useEsp32DisplayConnection";
import {
  ESP32_DISPLAY_FPS_OPTIONS,
  ESP32_DISPLAY_OUTPUT_SIZE_OPTIONS,
  type Esp32DisplayFps,
  type Esp32DisplayOutputSize,
} from "./types";

const { config, reset } = useEsp32DisplaySettings();
const { connected, lastError, start, stop } = useEsp32DisplayConnection();

const isStarting = ref(false);
const isStopping = ref(false);
const lastToggleError = ref("");

const statusLabel = computed(() => {
  if (connected.value) {
    return "active";
  }
  if (lastError.value) {
    return "error";
  }
  return "idle";
});

async function applyToggle(): Promise<void> {
  lastToggleError.value = "";
  if (config.enabled) {
    isStarting.value = true;
    try {
      const ok = await start(config);
      if (!ok) {
        config.enabled = false;
        lastToggleError.value = lastError.value || "start_failed";
      }
    } catch (error) {
      config.enabled = false;
      lastToggleError.value = error instanceof Error ? error.message : "start_failed";
    } finally {
      isStarting.value = false;
    }
  } else {
    isStopping.value = true;
    try {
      await stop();
    } finally {
      isStopping.value = false;
    }
  }
}

async function applyConnection(): Promise<void> {
  lastToggleError.value = "";
  await stop();
  if (config.enabled) {
    const ok = await start(config);
    if (!ok) {
      lastToggleError.value = lastError.value || "start_failed";
    }
  }
}

async function resetAndStop(): Promise<void> {
  lastToggleError.value = "";
  await stop();
  reset();
}

function setFps(value: number): void {
  if ((ESP32_DISPLAY_FPS_OPTIONS as readonly number[]).includes(value)) {
    config.fps = value as Esp32DisplayFps;
  }
}

function setOutputSize(value: number): void {
  if ((ESP32_DISPLAY_OUTPUT_SIZE_OPTIONS as readonly number[]).includes(value)) {
    config.outputSize = value as Esp32DisplayOutputSize;
  }
}

function setCropField(field: "x" | "y" | "w" | "h", value: number): void {
  const next = Math.min(1, Math.max(0, Number(value) || 0));
  if (field === "w") {
    config.crop.w = Math.max(0.05, next);
    config.crop.x = Math.min(config.crop.x, 1 - config.crop.w);
    return;
  }
  if (field === "h") {
    config.crop.h = Math.max(0.05, next);
    config.crop.y = Math.min(config.crop.y, 1 - config.crop.h);
    return;
  }
  if (field === "x") {
    config.crop.x = Math.min(next, 1 - config.crop.w);
    return;
  }
  config.crop.y = Math.min(next, 1 - config.crop.h);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
</script>

<template>
  <article class="settings-card settings-card--wide">
    <div class="settings-card__header">
      <div>
        <p class="settings-card__eyebrow">外设</p>
        <h2>外接小屏 (ESP32 缩略图)</h2>
      </div>
      <span class="settings-card__badge">{{ statusLabel }}</span>
    </div>

    <label class="settings-toggle">
      <input
        v-model="config.enabled"
        class="settings-toggle__input"
        type="checkbox"
        :disabled="isStarting || isStopping"
        @change="applyToggle"
      />
      <span class="settings-toggle__control" aria-hidden="true"></span>
      <span class="settings-toggle__copy">
        开启后会把桌宠头部画面合成 JPEG，按设定频率推送到
        ESP32 小屏。走主进程 raw TCP，协议与现有 send_screen_share.py 一致。
      </span>
    </label>

    <div class="settings-card__row">
      <label class="settings-card__field">
        <span>目标 IP</span>
        <input
          v-model="config.host"
          class="settings-card__input"
          type="text"
          placeholder="192.168.5.7"
        />
      </label>
      <label class="settings-card__field settings-card__field--narrow">
        <span>端口</span>
        <input
          v-model.number="config.port"
          class="settings-card__input"
          type="number"
          min="1"
          max="65535"
        />
      </label>
      <label class="settings-card__field settings-card__field--narrow">
        <span>帧率</span>
        <select
          class="settings-card__input"
          :value="config.fps"
          @change="setFps(Number(($event.target as HTMLSelectElement).value))"
        >
          <option v-for="value in ESP32_DISPLAY_FPS_OPTIONS" :key="value" :value="value">
            {{ value }} fps
          </option>
        </select>
      </label>
      <label class="settings-card__field settings-card__field--narrow">
        <span>分辨率</span>
        <select
          class="settings-card__input"
          :value="config.outputSize"
          @change="setOutputSize(Number(($event.target as HTMLSelectElement).value))"
        >
          <option
            v-for="value in ESP32_DISPLAY_OUTPUT_SIZE_OPTIONS"
            :key="value"
            :value="value"
          >
            {{ value }}×{{ value }}
          </option>
        </select>
      </label>
    </div>

    <div class="settings-card__slider-grid">
      <div class="settings-slider">
        <div class="settings-slider__header">
          <strong>裁剪 X (相对画布)</strong>
          <span class="settings-slider__value">{{ formatPercent(config.crop.x) }}</span>
        </div>
        <input
          class="settings-slider__input"
          type="range"
          min="0"
          :max="Math.max(0, 1 - config.crop.w)"
          step="0.01"
          :value="config.crop.x"
          @input="setCropField('x', Number(($event.target as HTMLInputElement).value))"
        />
      </div>
      <div class="settings-slider">
        <div class="settings-slider__header">
          <strong>裁剪 Y (相对画布)</strong>
          <span class="settings-slider__value">{{ formatPercent(config.crop.y) }}</span>
        </div>
        <input
          class="settings-slider__input"
          type="range"
          min="0"
          :max="Math.max(0, 1 - config.crop.h)"
          step="0.01"
          :value="config.crop.y"
          @input="setCropField('y', Number(($event.target as HTMLInputElement).value))"
        />
      </div>
      <div class="settings-slider">
        <div class="settings-slider__header">
          <strong>裁剪 W</strong>
          <span class="settings-slider__value">{{ formatPercent(config.crop.w) }}</span>
        </div>
        <input
          class="settings-slider__input"
          type="range"
          min="0.05"
          max="1"
          step="0.01"
          :value="config.crop.w"
          @input="setCropField('w', Number(($event.target as HTMLInputElement).value))"
        />
      </div>
      <div class="settings-slider">
        <div class="settings-slider__header">
          <strong>裁剪 H</strong>
          <span class="settings-slider__value">{{ formatPercent(config.crop.h) }}</span>
        </div>
        <input
          class="settings-slider__input"
          type="range"
          min="0.05"
          max="1"
          step="0.01"
          :value="config.crop.h"
          @input="setCropField('h', Number(($event.target as HTMLInputElement).value))"
        />
      </div>
    </div>

    <div class="settings-card__actions">
      <button
        type="button"
        class="settings-card__button settings-card__button--ghost"
        @click="applyConnection"
      >
        应用连接参数
      </button>
      <button
        type="button"
        class="settings-card__button settings-card__button--ghost"
        @click="resetAndStop"
      >
        恢复默认
      </button>
    </div>

    <p v-if="lastToggleError" class="settings-card__hint settings-card__hint--error">
      {{ lastToggleError }}
    </p>
    <p v-else-if="lastError" class="settings-card__hint settings-card__hint--error">
      {{ lastError }}
    </p>
    <p class="settings-card__hint">
      头部画布来自桌宠窗口；裁剪坐标是相对画布像素的比例。设置会自动保存到
      localStorage，桌宠窗口和设置窗口共享同一份配置。
    </p>
  </article>
</template>

<style scoped>
.settings-card__row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.settings-card__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  flex: 1 1 12rem;
  min-width: 0;
}

.settings-card__field > span {
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.65);
}

.settings-card__field--narrow {
  flex: 0 1 8rem;
}

.settings-card__slider-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.settings-card__hint--error {
  color: #ff8a8a;
}
</style>
