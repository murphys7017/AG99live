<script setup lang="ts">
import { onMounted } from "vue";
import DesktopWindowPanel from "../components/DesktopWindowPanel.vue";
import { useSettingsWindow } from "../settings/useSettingsWindow";

const {
  bridgeState,
  draftAddress,
  desktopScreenshotOnSendEnabled,
  microphoneDeviceId,
  microphoneDeviceStatus,
  ambientMotionEnabled,
  pttModeEnabled,
  motionEngineSettings,
  statusLabel,
  profileEditorButtonLabel,
  defaultAdapterAddress,
  motionIntensityMin,
  motionIntensityMax,
  motionIntensityStep,
  applyAddress,
  connectAdapter,
  disconnectAdapter,
  toggleHistoryWindow,
  toggleActionLabWindow,
  toggleProfileEditorWindow,
  applyDesktopScreenshotOnSend,
  applyMicrophoneDevice,
  refreshMicrophoneDevices,
  applyAmbientMotionEnabled,
  applyPttModeEnabled,
  applyMotionEngineSettings,
  resetMotionEngineSettings,
  requestModelProjectionSync,
  formatScale,
} = useSettingsWindow();

onMounted(() => {
  requestModelProjectionSync();
});
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
          :placeholder="defaultAdapterAddress"
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
          {{ bridgeState.snapshot.connectionStatusMessage }}
        </p>
      </article>

      <article class="settings-card">
        <div class="settings-card__header">
          <div>
            <p class="settings-card__eyebrow">语音输入</p>
            <h2>麦克风设备</h2>
          </div>
          <span class="settings-card__badge">
            {{ bridgeState.snapshot.micCapturing ? "active" : "idle" }}
          </span>
        </div>

        <select
          v-model="microphoneDeviceId"
          class="settings-card__input action-preview__select"
          @change="applyMicrophoneDevice"
        >
          <option value="">系统默认麦克风</option>
          <option
            v-for="device in bridgeState.snapshot.microphoneDevices"
            :key="device.deviceId"
            :value="device.deviceId"
          >
            {{ device.label }}
          </option>
        </select>

        <div class="settings-card__actions">
          <button
            type="button"
            class="settings-card__button settings-card__button--ghost"
            @click="void refreshMicrophoneDevices()"
          >
            刷新设备
          </button>
        </div>
        <p v-if="microphoneDeviceStatus" class="settings-card__hint">
          {{ microphoneDeviceStatus }}
        </p>
      </article>

      <article class="settings-card">
        <div class="settings-card__header">
          <div>
            <p class="settings-card__eyebrow">运行状态</p>
            <h2>{{ bridgeState.modelProjectionSnapshot.selectedModelName || "等待模型同步" }}</h2>
          </div>
          <span class="settings-card__badge">
            {{ bridgeState.modelProjectionSnapshot.recommendedMode || "await-sync" }}
          </span>
        </div>

        <dl class="settings-card__meta">
          <div>
            <dt>配置</dt>
            <dd>{{ bridgeState.snapshot.confName || "未同步" }}</dd>
          </div>
          <div>
            <dt>内部 WS</dt>
            <dd>{{ bridgeState.snapshot.serverWsUrl || "等待后端下发" }}</dd>
          </div>
          <div>
            <dt>内部 HTTP</dt>
            <dd>{{ bridgeState.snapshot.httpBaseUrl || "等待后端下发" }}</dd>
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

      <article class="settings-card">
        <div class="settings-card__header">
          <div>
            <p class="settings-card__eyebrow">动作</p>
            <h2>默认待机动作</h2>
          </div>
          <span class="settings-card__badge">
            {{ ambientMotionEnabled ? "enabled" : "disabled" }}
          </span>
        </div>

        <label class="settings-toggle">
          <input
            v-model="ambientMotionEnabled"
            class="settings-toggle__input"
            type="checkbox"
            @change="applyAmbientMotionEnabled"
          />
          <span class="settings-toggle__control" aria-hidden="true"></span>
          <span class="settings-toggle__copy">
            控制 Live2D 的默认待机驱动。关闭后会停用自动待机动作、自动呼吸和自动眨眼，方便只观察对话触发的动作。
          </span>
        </label>

        <p class="settings-card__hint">
          关闭后仍然保留对话动作、动作预览、口型同步和手动触发的 motion。
        </p>
      </article>

      <article class="settings-card">
        <div class="settings-card__header">
          <div>
            <p class="settings-card__eyebrow">收音</p>
            <h2>按键说话模式</h2>
          </div>
          <span class="settings-card__badge">
            {{ pttModeEnabled ? "enabled" : "disabled" }}
          </span>
        </div>

        <label class="settings-toggle">
          <input
            v-model="pttModeEnabled"
            class="settings-toggle__input"
            type="checkbox"
            @change="applyPttModeEnabled"
          />
          <span class="settings-toggle__control" aria-hidden="true"></span>
          <span class="settings-toggle__copy">
            开启后麦克风默认关闭。长按 Ctrl 键开始收音，松开 Ctrl 停止收音。关闭后恢复手动开关麦克风。
          </span>
        </label>

        <p class="settings-card__hint">
          按键说话模式下，"开始/停止麦克风"按钮仍可手动接管。切换模式会关闭当前收音。
        </p>
      </article>

      <article class="settings-card settings-card--wide">
        <div class="settings-card__header">
          <div>
            <p class="settings-card__eyebrow">动作强度</p>
            <h2>ModelEngine 表现倍率</h2>
          </div>
          <span class="settings-card__badge">
            x{{ formatScale(motionEngineSettings.motionIntensityScale) }}
          </span>
        </div>

        <div class="settings-slider">
          <div class="settings-slider__header">
            <div>
              <strong>全局动作强度</strong>
              <p>只对 expressive intent 生效，idle 不做放大。</p>
            </div>
            <span class="settings-slider__value">
              x{{ formatScale(motionEngineSettings.motionIntensityScale) }}
            </span>
          </div>
          <input
            v-model.number="motionEngineSettings.motionIntensityScale"
            class="settings-slider__input"
            type="range"
            :min="motionIntensityMin"
            :max="motionIntensityMax"
            :step="motionIntensityStep"
            @input="applyMotionEngineSettings"
          />
        </div>

        <div class="settings-card__actions">
          <button
            type="button"
            class="settings-card__button settings-card__button--ghost"
            @click="resetMotionEngineSettings"
          >
            重置为默认
          </button>
        </div>

        <p class="settings-card__hint">
          当前只保留会真正影响动态主轴 v2 的全局强度。旧 12 轴逐轴倍率已从设置界面下线，避免出现能调但不生效的兼容项。
        </p>
      </article>

      <article class="settings-card settings-card--wide">
        <div class="settings-card__header">
          <div>
            <p class="settings-card__eyebrow">最近消息</p>
            <h2>连接状态</h2>
          </div>
          <span class="settings-card__badge">
            {{ bridgeState.snapshot.connectionLabel }}
          </span>
        </div>

        <p class="settings-card__copy">{{ bridgeState.snapshot.stageMessage }}</p>

        <div class="settings-card__stack">
          <div>
            <span>最近输入</span>
            <strong>{{ bridgeState.snapshot.lastSentText || "暂无" }}</strong>
          </div>
          <div>
            <span>最近回复</span>
            <strong>{{ bridgeState.snapshot.lastAssistantText || "暂无" }}</strong>
          </div>
          <div>
            <span>最近转写</span>
            <strong>{{ bridgeState.snapshot.lastTranscription || "暂无" }}</strong>
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
        <button
          type="button"
          class="settings-card__button settings-card__button--ghost"
          @click="toggleProfileEditorWindow"
        >
          {{ profileEditorButtonLabel }}
        </button>
      </article>
    </section>
  </DesktopWindowPanel>
</template>
