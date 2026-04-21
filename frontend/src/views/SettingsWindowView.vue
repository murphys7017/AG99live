<script setup lang="ts">
import { computed, ref, watch } from "vue";
import DesktopWindowPanel from "../components/DesktopWindowPanel.vue";
import { useDesktopBridge } from "../composables/useDesktopBridge";

const bridge = useDesktopBridge();
const draftAddress = ref(bridge.state.snapshot.adapterAddress);
const desktopScreenshotOnSendEnabled = ref(
  bridge.state.snapshot.desktopScreenshotOnSendEnabled,
);

watch(
  () => bridge.state.snapshot.adapterAddress,
  (nextValue) => {
    draftAddress.value = nextValue;
  },
);

watch(
  () => bridge.state.snapshot.desktopScreenshotOnSendEnabled,
  (nextValue) => {
    desktopScreenshotOnSendEnabled.value = nextValue;
  },
);

const statusLabel = computed(() => {
  if (bridge.state.snapshot.connectionState === "synced") {
    return "模型已同步";
  }
  if (bridge.state.snapshot.connectionState === "connecting") {
    return "连接中";
  }
  if (bridge.state.snapshot.connectionState === "error") {
    return "连接异常";
  }
  if (bridge.state.snapshot.connectionState === "linked") {
    return "适配器已连接";
  }
  return "尚未连接";
});

function applyAddress(): void {
  bridge.sendCommand({ type: "set_address", address: draftAddress.value });
}

function connectAdapter(): void {
  bridge.sendCommand({ type: "connect", address: draftAddress.value });
}

function disconnectAdapter(): void {
  bridge.sendCommand({ type: "disconnect" });
}

function toggleHistoryWindow(): void {
  window.ag99desktop?.toggleAuxWindow("history");
}

function toggleActionLabWindow(): void {
  window.ag99desktop?.toggleAuxWindow("action_lab");
}

function applyDesktopScreenshotOnSend(): void {
  bridge.sendCommand({
    type: "set_desktop_screenshot_on_send",
    enabled: desktopScreenshotOnSendEnabled.value,
  });
}
</script>

<template>
  <DesktopWindowPanel title="系统设置" subtitle="AG99live Desktop">
    <section class="settings-grid">
      <article class="settings-card">
        <div class="settings-card__header">
          <div>
            <p class="settings-card__eyebrow">连接</p>
            <h2>后端地址</h2>
          </div>
          <span class="settings-card__badge">{{ statusLabel }}</span>
        </div>

        <input
          v-model="draftAddress"
          class="settings-card__input"
          placeholder="127.0.0.1:12396"
        />

        <div class="settings-card__actions">
          <button type="button" class="settings-card__button" @click="applyAddress">
            保存地址
          </button>
          <button type="button" class="settings-card__button" @click="connectAdapter">
            连接
          </button>
          <button
            type="button"
            class="settings-card__button settings-card__button--ghost"
            @click="disconnectAdapter"
          >
            断开
          </button>
        </div>

        <p class="settings-card__hint">
          只需要填写一个适配器地址，WS 和 HTTP 会在内部自动派生。
          {{ bridge.state.snapshot.connectionStatusMessage }}
        </p>
      </article>

      <article class="settings-card">
        <div class="settings-card__header">
          <div>
            <p class="settings-card__eyebrow">运行状态</p>
            <h2>{{ bridge.state.snapshot.selectedModelName || "等待模型同步" }}</h2>
          </div>
          <span class="settings-card__badge">
            {{ bridge.state.snapshot.recommendedMode || "await-sync" }}
          </span>
        </div>

        <dl class="settings-card__meta">
          <div>
            <dt>会话</dt>
            <dd>{{ bridge.state.snapshot.sessionId || "未同步" }}</dd>
          </div>
          <div>
            <dt>配置</dt>
            <dd>{{ bridge.state.snapshot.confName || "未同步" }}</dd>
          </div>
          <div>
            <dt>内部 WS</dt>
            <dd>{{ bridge.state.snapshot.serverWsUrl || "等待后端下发" }}</dd>
          </div>
          <div>
            <dt>内部 HTTP</dt>
            <dd>{{ bridge.state.snapshot.httpBaseUrl || "等待后端下发" }}</dd>
          </div>
        </dl>
      </article>

      <article class="settings-card">
        <div class="settings-card__header">
          <div>
            <p class="settings-card__eyebrow">多模态</p>
            <h2>发送时附带桌面截图</h2>
          </div>
          <span class="settings-card__badge">
            {{ desktopScreenshotOnSendEnabled ? "enabled" : "disabled" }}
          </span>
        </div>

        <label class="settings-toggle">
          <input
            v-model="desktopScreenshotOnSendEnabled"
            class="settings-toggle__input"
            type="checkbox"
            @change="applyDesktopScreenshotOnSend"
          />
          <span class="settings-toggle__control" aria-hidden="true"></span>
          <span class="settings-toggle__copy">
            发送文本时自动附带一张实时桌面截图，帮助模型理解当前屏幕内容。
          </span>
        </label>

        <p class="settings-card__hint">
          关闭后仍然可以正常聊天，只是不再自动把当前桌面作为上下文一并发送。
        </p>
      </article>

      <article class="settings-card settings-card--wide">
        <div class="settings-card__header">
          <div>
            <p class="settings-card__eyebrow">最近消息</p>
            <h2>连接状态</h2>
          </div>
          <span class="settings-card__badge">
            {{ bridge.state.snapshot.connectionLabel }}
          </span>
        </div>

        <p class="settings-card__copy">{{ bridge.state.snapshot.stageMessage }}</p>

        <div class="settings-card__stack">
          <div>
            <span>最近输入</span>
            <strong>{{ bridge.state.snapshot.lastSentText || "暂无" }}</strong>
          </div>
          <div>
            <span>最近回复</span>
            <strong>{{ bridge.state.snapshot.lastAssistantText || "暂无" }}</strong>
          </div>
          <div>
            <span>最近转写</span>
            <strong>{{ bridge.state.snapshot.lastTranscription || "暂无" }}</strong>
          </div>
        </div>

        <button
          type="button"
          class="settings-card__button settings-card__button--ghost"
          @click="toggleHistoryWindow"
        >
          打开或关闭历史窗口
        </button>
        <button
          type="button"
          class="settings-card__button settings-card__button--ghost"
          @click="toggleActionLabWindow"
        >
          打开动作实验室
        </button>
      </article>
    </section>
  </DesktopWindowPanel>
</template>
