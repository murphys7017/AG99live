<script setup lang="ts">
import { computed, toRef } from "vue";
import type { ModelSummary } from "../types/protocol";
import { useLive2dRenderer } from "../composables/useLive2dRenderer";

const props = defineProps<{
  selectedModel: ModelSummary | null;
  connectionLabel: string;
  stageMessage: string;
  lastSentText: string;
}>();

const selectedModelRef = toRef(props, "selectedModel");
const {
  containerRef,
  canvasRef,
  renderStatus,
  renderError,
  statusLabel,
} = useLive2dRenderer(selectedModelRef);

const modelInitials = computed(() => {
  const name = props.selectedModel?.name?.trim();
  if (!name) {
    return "AG";
  }
  return name.slice(0, 2).toUpperCase();
});

const stageChips = computed(() => {
  if (!props.selectedModel) {
    return ["pet-mode", "parameter-first", "await-sync"];
  }
  return props.selectedModel.engine_hints.available_channels.slice(0, 6);
});

const showFallback = computed(() => {
  return renderStatus.value !== "ready";
});
</script>

<template>
  <section class="pet-stage">
    <div class="pet-stage__speech glass-panel">
      <span class="pet-stage__speech-label">{{ connectionLabel }}</span>
      <p>{{ stageMessage }}</p>
    </div>

    <div class="pet-stage__platform">
      <div class="pet-stage__halo"></div>
      <div class="pet-stage__avatar-shell glass-panel">
        <div id="live2d" ref="containerRef" class="pet-stage__live2d-mount">
          <canvas id="canvas" ref="canvasRef" class="pet-stage__live2d-canvas"></canvas>

          <img
            v-if="showFallback && selectedModel?.icon_url"
            :src="selectedModel.icon_url"
            :alt="selectedModel.name"
            class="pet-stage__avatar-image pet-stage__avatar-image--fallback"
          />
          <div v-else-if="showFallback" class="pet-stage__avatar-fallback">
            <span>{{ modelInitials }}</span>
          </div>

          <div class="pet-stage__runtime-badge" :data-status="renderStatus">
            {{ statusLabel }}
          </div>
          <p v-if="renderError" class="pet-stage__runtime-error">{{ renderError }}</p>
        </div>

        <div class="pet-stage__nameplate">
          <strong>{{ selectedModel?.name ?? "等待模型" }}</strong>
          <span>
            {{
              selectedModel?.engine_hints.recommended_mode ??
              "parameter_primary"
            }}
          </span>
        </div>
      </div>
    </div>

    <div class="pet-stage__meta glass-panel">
      <div class="pet-stage__meta-head">
        <div>
          <p class="pet-stage__meta-kicker">Pet Stage</p>
          <h2>桌宠舞台</h2>
        </div>
        <span class="pet-stage__meta-badge">仅保留 Pet 模式</span>
      </div>

      <p class="pet-stage__meta-copy">
        现在已经接入了 V1 同路线的 Live2D WebSDK 渲染底座。当前先完成模型加载与舞台挂载，下一步再把参数 runtime 和动作引擎接上来。
      </p>

      <div class="pet-stage__chips">
        <span v-for="chip in stageChips" :key="chip" class="pet-stage__chip">
          {{ chip }}
        </span>
      </div>

      <p v-if="lastSentText" class="pet-stage__echo">
        你刚刚输入了：“{{ lastSentText }}”
      </p>
    </div>
  </section>
</template>
