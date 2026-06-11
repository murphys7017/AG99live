<script setup lang="ts">
import { onMounted } from "vue";
import DesktopWindowPanel from "../components/DesktopWindowPanel.vue";
import { useSettingsWindow } from "../settings/useSettingsWindow";
import Esp32DisplaySettingsCard from "../esp32-display/Esp32DisplaySettingsCard.vue";

const {
  bridgeState,
  draftAddress,
  desktopScreenshotOnSendEnabled,
  microphoneDeviceId,
  microphoneDeviceStatus,
  ambientMotionEnabled,
  pttModeEnabled,
  pttKeyBinding,
  pttKeyCaptureActive,
  pttKeyStatus,
  motionEngineSettings,
  bilibiliLiveSettings,
  statusLabel,
  profileEditorButtonLabel,
  defaultAdapterAddress,
  motionIntensityMin,
  motionIntensityMax,
  motionIntensityStep,
  live2dRenderDprCapMin,
  live2dRenderDprCapMax,
  live2dRenderDprCapStep,
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
  startPttKeyCapture,
  capturePttKey,
  applyMotionEngineSettings,
  resetMotionEngineSettings,
  applyBilibiliLiveSettings,
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

      <article class="settings-card settings-card--wide">
        <div class="settings-card__header">
          <div>
            <p class="settings-card__eyebrow">渲染</p>
            <h2>Live2D 清晰度</h2>
          </div>
          <span class="settings-card__badge">
            x{{ formatScale(motionEngineSettings.live2dRenderDprCap) }}
          </span>
        </div>

        <div class="settings-slider">
          <div class="settings-slider__header">
            <div>
              <strong>渲染分辨率上限</strong>
              <p>数值越高越清晰，也会增加显卡负载。</p>
            </div>
            <span class="settings-slider__value">
              x{{ formatScale(motionEngineSettings.live2dRenderDprCap) }}
            </span>
          </div>
          <input
            v-model.number="motionEngineSettings.live2dRenderDprCap"
            class="settings-slider__input"
            type="range"
            :min="live2dRenderDprCapMin"
            :max="live2dRenderDprCapMax"
            :step="live2dRenderDprCapStep"
            @input="applyMotionEngineSettings"
          />
        </div>
      </article>

      <article class="settings-card settings-card--wide">
        <div class="settings-card__header">
          <div>
            <p class="settings-card__eyebrow">直播输入</p>
            <h2>B 站直播弹幕</h2>
          </div>
          <span class="settings-card__badge">
            {{ bridgeState.snapshot.bilibiliLiveStatus.status }}
          </span>
        </div>

        <label class="settings-toggle">
          <input
            v-model="bilibiliLiveSettings.enabled"
            class="settings-toggle__input"
            type="checkbox"
            @change="applyBilibiliLiveSettings"
          />
          <span class="settings-toggle__control" aria-hidden="true"></span>
          <span class="settings-toggle__copy">
            开启后桌宠窗口会连接直播间弹幕，并按设定间隔把弹幕批次作为一次普通文本输入提交给后端。
          </span>
        </label>

        <div class="settings-slider-grid">
          <label class="settings-slider">
            <div class="settings-slider__header">
              <div>
                <strong>房间 ID</strong>
                <p>必填，填写直播间 URL 中的数字房间号。</p>
              </div>
            </div>
            <input
              v-model="bilibiliLiveSettings.roomId"
              class="settings-card__input"
              inputmode="numeric"
              placeholder="例如 123456"
              @change="applyBilibiliLiveSettings"
            />
          </label>

          <label class="settings-slider">
            <div class="settings-slider__header">
              <div>
                <strong>响应间隔</strong>
                <p>到达间隔后，如果当前没有手动输入或回复播放，就提交一批弹幕。</p>
              </div>
              <span class="settings-slider__value">
                {{ bilibiliLiveSettings.responseIntervalSeconds }}s
              </span>
            </div>
            <input
              v-model.number="bilibiliLiveSettings.responseIntervalSeconds"
              class="settings-slider__input"
              type="range"
              min="5"
              max="180"
              step="5"
              @change="applyBilibiliLiveSettings"
            />
          </label>
        </div>

        <input
          v-model="bilibiliLiveSettings.cookie"
          class="settings-card__input"
          type="password"
          autocomplete="off"
          placeholder="Cookie，可留空"
          @change="applyBilibiliLiveSettings"
        />

        <div class="settings-card__actions">
          <button type="button" class="settings-card__button" @click="applyBilibiliLiveSettings">
            应用直播设置
          </button>
        </div>

        <p class="settings-card__hint">
          状态：{{ bridgeState.snapshot.bilibiliLiveStatus.connected ? "已连接" : "未连接" }}；
          房间：{{ bridgeState.snapshot.bilibiliLiveStatus.realRoomId || bridgeState.snapshot.bilibiliLiveStatus.roomId || "未设置" }}；
          待响应弹幕：{{ bridgeState.snapshot.bilibiliLiveStatus.bufferedCount }}；
          Cookie：{{ bridgeState.snapshot.bilibiliLiveStatus.hasCookie ? "已配置" : "未配置" }}。
          {{ bridgeState.snapshot.bilibiliLiveStatus.lastError }}
        </p>
        <p class="settings-card__hint">
          鉴权：{{ bridgeState.snapshot.bilibiliLiveStatus.authReceived ? "ok" : "-" }}；
          心跳：{{ bridgeState.snapshot.bilibiliLiveStatus.heartbeatReceived ? "ok" : "-" }}；
          协议：{{ bridgeState.snapshot.bilibiliLiveStatus.protover ?? "-" }}；
          命令：{{ bridgeState.snapshot.bilibiliLiveStatus.commandCount }}；
          弹幕：{{ bridgeState.snapshot.bilibiliLiveStatus.danmakuCount }}；
          最近命令：{{ bridgeState.snapshot.bilibiliLiveStatus.lastCommand || "-" }}。
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
            开启后麦克风默认关闭。长按当前配置按键开始收音，松开按键停止收音。关闭后恢复手动开关麦克风。
          </span>
        </label>

        <div class="settings-card__actions">
          <button
            type="button"
            class="settings-card__button settings-card__button--ghost"
            @click="startPttKeyCapture"
            @keydown="capturePttKey"
          >
            {{ pttKeyCaptureActive ? "按下任意键" : `当前按键：${pttKeyBinding.label}` }}
          </button>
        </div>

        <p class="settings-card__hint">
          按键说话模式下，"开始/停止麦克风"按钮仍可手动接管。切换模式会关闭当前收音。
          {{ pttKeyStatus }}
        </p>
        <p
          v-if="pttModeEnabled && !bridgeState.snapshot.pttHookStatus.available"
          class="settings-card__hint"
        >
          全局按键不可用，当前会退回到桌宠窗口获得焦点时触发。
          {{ bridgeState.snapshot.pttHookStatus.reason }}
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

      <Esp32DisplaySettingsCard />
    </section>
  </DesktopWindowPanel>
</template>
