<script setup lang="ts">
import { computed } from "vue";
import type { ModelSummary } from "../types/protocol";
import { DEFAULT_ADAPTER_ADDRESS } from "../adapter-connection/address";

const props = defineProps<{
  selectedModel: ModelSummary | null;
  sessionId: string;
  confName: string;
  lastUpdated: string;
  connectionLabel: string;
  adapterAddress: string;
  connectionState: string;
  connectionStatusMessage: string;
  serverWsUrl: string;
  httpBaseUrl: string;
}>();

const emit = defineEmits<{
  "update:adapter-address": [value: string];
  connect: [];
  disconnect: [];
}>();

const hasModel = computed(() => Boolean(props.selectedModel));
const isConnected = computed(
  () => props.connectionState === "connected" || props.connectionState === "connecting",
);
const formattedLastUpdated = computed(() => {
  if (!props.lastUpdated) {
    return "尚未收到同步";
  }

  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(props.lastUpdated));
  } catch (_error) {
    return props.lastUpdated;
  }
});

const channelCount = computed(
  () => props.selectedModel?.engine_hints.available_channels.length ?? 0,
);
</script>

<template>
  <aside class="launch-card glass-panel">
    <div class="launch-card__topline">
      <span class="launch-card__eyebrow">首发信息</span>
      <span class="launch-card__status">{{ connectionLabel }}</span>
    </div>

    <template v-if="!hasModel">
      <p class="launch-card__motto">欢迎点燃自己的历史</p>
      <h1 class="launch-card__title">AG99live 现在只保留 Pet 模式</h1>
      <p class="launch-card__description">
        这一版前端先围绕桌宠常驻体验重做。窗口模式不进入首发范围，先把模型舞台、桌宠输入浮层和动作引擎入口打稳。
      </p>

      <div class="launch-card__steps">
        <div class="launch-step">
          <strong>01</strong>
          <div>
            <h2>连接适配器</h2>
            <p>前端只感知一个适配器地址，WS 和 HTTP 由内部自动收口。</p>
          </div>
        </div>
        <div class="launch-step">
          <strong>02</strong>
          <div>
            <h2>加载模型扫描结果</h2>
            <p>优先读取参数主通道，expression 与 motion 只作为补充与兜底。</p>
          </div>
        </div>
        <div class="launch-step">
          <strong>03</strong>
          <div>
            <h2>进入桌宠交互</h2>
            <p>保留轻量输入、状态提示和最近消息，不把整套窗口 UI 带回来。</p>
          </div>
        </div>
      </div>
    </template>

    <template v-else>
      <p class="launch-card__motto launch-card__motto--compact">Pet 模式已就绪</p>
      <h1 class="launch-card__title">{{ selectedModel?.name }}</h1>
      <p class="launch-card__description">
        当前模型已经同步，前端可以直接围绕参数驱动做 runtime。后续动作引擎、时间轴和渲染层都以这份能力画像为入口。
      </p>

      <div class="launch-summary">
        <div class="launch-summary__item">
          <span>会话</span>
          <strong>{{ sessionId || "未命名" }}</strong>
        </div>
        <div class="launch-summary__item">
          <span>配置</span>
          <strong>{{ confName || "未同步" }}</strong>
        </div>
        <div class="launch-summary__item">
          <span>可用通道</span>
          <strong>{{ channelCount }}</strong>
        </div>
        <div class="launch-summary__item">
          <span>最近更新</span>
          <strong>{{ formattedLastUpdated }}</strong>
        </div>
      </div>
    </template>

    <div class="launch-card__connect-panel">
      <label class="launch-card__field">
        <span>适配器地址</span>
        <input
          :value="adapterAddress"
          class="launch-card__input"
          :placeholder="DEFAULT_ADAPTER_ADDRESS"
          @input="
            emit(
              'update:adapter-address',
              ($event.target as HTMLInputElement).value,
            )
          "
        />
      </label>

      <div class="launch-card__connect-actions">
        <button
          v-if="!isConnected"
          type="button"
          class="control-button control-button--primary control-button--inline"
          @click="$emit('connect')"
        >
          连接适配器
        </button>
        <button
          v-else
          type="button"
          class="control-button control-button--ghost"
          @click="$emit('disconnect')"
        >
          断开连接
        </button>
      </div>

      <p class="launch-card__connect-hint">{{ connectionStatusMessage }}</p>

      <div class="launch-card__endpoint-list">
        <div class="launch-summary__item">
          <span>WS</span>
          <strong>{{ serverWsUrl || "等待后端下发" }}</strong>
        </div>
        <div class="launch-summary__item">
          <span>HTTP</span>
          <strong>{{ httpBaseUrl || "等待后端下发" }}</strong>
        </div>
      </div>
    </div>
  </aside>
</template>
