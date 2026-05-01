<script setup lang="ts">
import DesktopWindowPanel from "../components/DesktopWindowPanel.vue";
import { useSettingsWindow } from "../composables/useSettingsWindow";

const {
  bridgeState,
  draftAddress,
  desktopScreenshotOnSendEnabled,
  ambientMotionEnabled,
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
  applyAmbientMotionEnabled,
  applyMotionEngineSettings,
  resetMotionEngineSettings,
  formatScale,
} = useSettingsWindow();
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
            <p class="settings-card__eyebrow">运行状态</p>
            <h2>{{ bridgeState.snapshot.selectedModelName || "等待模型同步" }}</h2>
          </div>
          <span class="settings-card__badge">
            {{ bridgeState.snapshot.recommendedMode || "await-sync" }}
          </span>
        </div>

        <dl class="settings-card__meta">
          <div>
            <dt>会话</dt>
            <dd>{{ bridgeState.snapshot.sessionId || "未同步" }}</dd>
          </div>
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
