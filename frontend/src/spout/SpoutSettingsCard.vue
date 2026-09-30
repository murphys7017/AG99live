<script setup lang="ts">
import { computed } from "vue";
import { useSpoutSettings } from "./useSpoutSettings";

const { config, reset } = useSpoutSettings();
const statusLabel = computed(() => (config.enabled ? "enabled" : "disabled"));
</script>

<template>
  <article class="settings-card">
    <div class="settings-card__header">
      <div>
        <p class="settings-card__eyebrow">外设</p>
        <h2>Spout2 透明输出</h2>
      </div>
      <span class="settings-card__badge">{{ statusLabel }}</span>
    </div>

    <label class="settings-toggle">
      <input
        v-model="config.enabled"
        class="settings-toggle__input"
        type="checkbox"
      />
      <span class="settings-toggle__control" aria-hidden="true"></span>
      <span class="settings-toggle__copy">
        开启后才会读取 Live2D 画面并发布到 OBS 的
        AG99live.Live2D Spout2 源；关闭后停止这条帧读回路径。
      </span>
    </label>

    <div class="settings-card__actions">
      <button
        type="button"
        class="settings-card__button settings-card__button--ghost"
        @click="reset"
      >
        关闭输出
      </button>
    </div>

    <p class="settings-card__hint">
      设置会自动保存，并在桌宠窗口和设置窗口之间同步。OBS 中无需使用窗口捕获。
    </p>
  </article>
</template>
