<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import MotionTuningPanel from "../components/MotionTuningPanel.vue";
import SemanticAxisProfileEditor from "../components/SemanticAxisProfileEditor.vue";
import type {
  DesktopMotionTuningSample,
  DesktopMotionTuningSamplesStatus,
  DesktopSemanticAxisProfileSaveResult,
} from "../types/desktop";
import type { SemanticAxisProfile } from "../types/semantic-axis-profile";
import type { CompiledSemanticMotion } from "../types/compiledSemanticMotion";
import type { SemanticParameterPlan } from "../types/protocol";
import {
  normalizeMotionTuningSamplesStatePayload,
  serializeMotionTuningSample,
} from "../adapter-connection/features/motionTuningPayload.js";

type ControlSection = "overview" | "settings" | "profile" | "action-lab";
type PluginSettings = {
  general: {
    client_uid: string;
    client_nickname: string;
    chat_buffer_size: number;
  };
  live2d_input: {
    model_name: string;
    image_cooldown_seconds: number;
  };
  performance_curve: {
    enabled: boolean;
    provider_id: string;
  };
  vad: {
    prob_threshold: number;
    required_hits: number;
    required_misses: number;
  };
};
type AdapterSummary = {
  platform_id: string;
  host: string;
  websocket_port: number;
  http_port: number;
  connected: boolean;
  selected_model: string;
  available_models: string[];
};
type OverviewResponse = { platforms: AdapterSummary[] };
type ProfileResponse = {
  model_name: string;
  profile: SemanticAxisProfile;
  models: { name: string; icon_url: string }[];
};
const section = ref<ControlSection>("overview");
const pageError = ref("");
const pageNotice = ref("");
const isLoading = ref(false);
const isSaving = ref(false);
const settingsSaving = ref(false);
const overview = ref<OverviewResponse>({ platforms: [] });
const selectedPlatformId = ref("");
const selectedModelName = ref("");
const profile = ref<SemanticAxisProfile | null>(null);
const profileModels = ref<ProfileResponse["models"]>([]);
const profileSaveResult = ref<DesktopSemanticAxisProfileSaveResult | null>(null);
const motionTuningSamples = ref<DesktopMotionTuningSample[]>([]);
const motionTuningStatus = ref<DesktopMotionTuningSamplesStatus>({
  rootError: "",
  loadError: "",
  diagnostics: [],
  effectiveExamples: [],
});
const settings = reactive<PluginSettings>({
  general: { client_uid: "desktop-client", client_nickname: "DesktopUser", chat_buffer_size: 10 },
  live2d_input: { model_name: "", image_cooldown_seconds: 0 },
  performance_curve: { enabled: false, provider_id: "" },
  vad: { prob_threshold: 0.4, required_hits: 3, required_misses: 24 },
});

const activePlatform = computed(() =>
  overview.value.platforms.find((item) => item.platform_id === selectedPlatformId.value) ?? null,
);
const activeTitle = computed(() => ({
  overview: "运行概况",
  settings: "系统设置",
  profile: "Profile Editor",
  "action-lab": "动作实验室",
}[section.value]));
const modelNameOptions = computed(() => activePlatform.value?.available_models ?? []);

function pageBridge() {
  const bridge = window.AstrBotPluginView;
  if (!bridge) {
    throw new Error("请从 AstrBot 控制面板的 AG99live 插件页面打开此界面。");
  }
  return bridge;
}

async function apiGet<T>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
  const bridge = pageBridge();
  await bridge.ready();
  return bridge.apiGet<T>(path, params);
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const bridge = pageBridge();
  await bridge.ready();
  return bridge.apiPost<T>(path, body);
}

function showError(error: unknown): void {
  pageError.value = error instanceof Error ? error.message : String(error);
  pageNotice.value = "";
}

function resetMessage(): void {
  pageError.value = "";
  pageNotice.value = "";
}

async function loadOverview(): Promise<void> {
  isLoading.value = true;
  resetMessage();
  try {
    overview.value = await apiGet<OverviewResponse>("control/overview");
    if (!overview.value.platforms.some((item) => item.platform_id === selectedPlatformId.value)) {
      selectedPlatformId.value = overview.value.platforms[0]?.platform_id ?? "";
    }
    await loadSettings();
    if (selectedPlatformId.value) {
      await Promise.all([loadProfile(), loadSamples()]);
    }
  } catch (error) {
    showError(error);
  } finally {
    isLoading.value = false;
  }
}

async function loadSettings(): Promise<void> {
  const response = await apiGet<{ settings: Partial<PluginSettings> }>("control/settings");
  for (const key of Object.keys(settings) as (keyof PluginSettings)[]) {
    const next = response.settings[key];
    if (next) Object.assign(settings[key], next);
  }
}

async function saveSettings(): Promise<void> {
  settingsSaving.value = true;
  resetMessage();
  try {
    const response = await apiPost<{ settings: PluginSettings }>("control/settings", {
      settings: JSON.parse(JSON.stringify(settings)),
    });
    for (const key of Object.keys(settings) as (keyof PluginSettings)[]) {
      Object.assign(settings[key], response.settings[key]);
    }
    await loadOverview();
    if (!pageError.value) {
      pageNotice.value = "AstrBot 插件配置已保存，Adapter 已刷新。";
    }
  } catch (error) {
    showError(error);
  } finally {
    settingsSaving.value = false;
  }
}

async function loadProfile(): Promise<void> {
  if (!selectedPlatformId.value) return;
  const query = {
    platform_id: selectedPlatformId.value,
    model_name: selectedModelName.value || activePlatform.value?.selected_model || "",
  };
  try {
    const response = await apiGet<ProfileResponse>("control/profile", query);
    selectedModelName.value = response.model_name;
    profile.value = response.profile;
    profileModels.value = response.models;
  } catch (error) {
    profile.value = null;
    if (error instanceof Error && !error.message.includes("semantic_axis_profile_not_found")) {
      showError(error);
    }
  }
}

async function saveProfile(payload: {
  requestId: string;
  modelName: string;
  profileId: string;
  expectedRevision: number;
  profile: SemanticAxisProfile;
}): Promise<void> {
  if (!selectedPlatformId.value) return;
  isSaving.value = true;
  resetMessage();
  try {
    profileSaveResult.value = await apiPost<DesktopSemanticAxisProfileSaveResult>(
      "control/profile",
      {
        platform_id: selectedPlatformId.value,
        request_id: payload.requestId,
        model_name: payload.modelName,
        profile_id: payload.profileId,
        expected_revision: payload.expectedRevision,
        profile: payload.profile,
      },
    );
    await loadProfile();
    pageNotice.value = "Profile 已保存。";
  } catch (error) {
    profileSaveResult.value = {
      requestId: payload.requestId,
      ok: false,
      modelName: payload.modelName,
      profileId: payload.profileId,
      expectedRevision: payload.expectedRevision,
      errorCode: "web_control_save_failed",
      message: error instanceof Error ? error.message : String(error),
      receivedAt: new Date().toISOString(),
    };
    showError(error);
  } finally {
    isSaving.value = false;
  }
}

async function loadSamples(): Promise<void> {
  if (!selectedPlatformId.value) return;
  try {
    const response = await apiGet<unknown>("control/samples", {
      platform_id: selectedPlatformId.value,
    });
    const normalized = normalizeMotionTuningSamplesStatePayload(response);
    motionTuningSamples.value = normalized.samples;
    motionTuningStatus.value = normalized.status;
  } catch (error) {
    showError(error);
  }
}

async function saveSample(sample: DesktopMotionTuningSample): Promise<void> {
  if (!selectedPlatformId.value) return;
  try {
    const response = await apiPost<unknown>("control/samples", {
      platform_id: selectedPlatformId.value,
      sample: serializeMotionTuningSample(sample),
    });
    const normalized = normalizeMotionTuningSamplesStatePayload(response);
    motionTuningSamples.value = normalized.samples;
    motionTuningStatus.value = normalized.status;
    pageNotice.value = "动作样例已保存。";
    pageError.value = "";
  } catch (error) {
    showError(error);
  }
}

async function deleteSample(sampleId: string): Promise<void> {
  if (!selectedPlatformId.value) return;
  try {
    const response = await apiPost<unknown>("control/samples/delete", {
      platform_id: selectedPlatformId.value,
      sample_id: sampleId,
    });
    const normalized = normalizeMotionTuningSamplesStatePayload(response);
    motionTuningSamples.value = normalized.samples;
    motionTuningStatus.value = normalized.status;
    pageNotice.value = "动作样例已删除。";
    pageError.value = "";
  } catch (error) {
    showError(error);
  }
}

function previewUnavailable(_motion: CompiledSemanticMotion): void {
  pageNotice.value = "动作样例管理已接通。桌面实时预览需要下一步加入受认证的桌面运行桥接，目前不会触发播放。";
  pageError.value = "";
}

function previewRecordedUnavailable(
  _plan: SemanticParameterPlan,
  _motion: CompiledSemanticMotion,
  _assistantText: string,
): void {
  previewUnavailable(_motion);
}

watch(selectedPlatformId, async (next, previous) => {
  if (!next || next === previous) return;
  selectedModelName.value = activePlatform.value?.selected_model ?? "";
  await loadOverview();
});

watch(selectedModelName, (next, previous) => {
  if (next && next !== previous && section.value === "profile") void loadProfile();
});

onMounted(() => void loadOverview());
</script>

<template>
  <main class="web-control-shell">
    <aside class="web-control-nav">
      <div class="web-control-brand">
        <span class="web-control-brand__mark">A</span>
        <div>
          <strong>AG99live</strong>
          <span>CONTROL PLANE</span>
        </div>
      </div>
      <nav aria-label="控制台导航">
        <button :aria-current="section === 'overview' ? 'page' : undefined" @click="section = 'overview'">概况</button>
        <button :aria-current="section === 'settings' ? 'page' : undefined" @click="section = 'settings'">系统设置</button>
        <button :aria-current="section === 'profile' ? 'page' : undefined" @click="section = 'profile'">Profile</button>
        <button :aria-current="section === 'action-lab' ? 'page' : undefined" @click="section = 'action-lab'">动作实验室</button>
      </nav>
      <div class="web-control-nav__footer">AstrBot Plugin Page</div>
    </aside>

    <section class="web-control-main">
      <header class="web-control-header">
        <div>
          <p>AG99LIVE / CONTROL</p>
          <h1>{{ activeTitle }}</h1>
        </div>
        <div class="web-control-header__tools">
          <label v-if="overview.platforms.length" class="web-control-platform-picker">
            <span>适配器</span>
            <select v-model="selectedPlatformId">
              <option v-for="item in overview.platforms" :key="item.platform_id" :value="item.platform_id">
                {{ item.platform_id }}
              </option>
            </select>
          </label>
          <button class="web-control-refresh" type="button" :disabled="isLoading" title="刷新" @click="void loadOverview()">刷新</button>
        </div>
      </header>

      <div v-if="pageError" class="web-control-message web-control-message--error" role="alert">{{ pageError }}</div>
      <div v-else-if="pageNotice" class="web-control-message" role="status">{{ pageNotice }}</div>

      <section v-if="section === 'overview'" class="web-control-content">
        <div class="web-control-section-heading">
          <div><p>STATUS</p><h2>Adapter 实例</h2></div>
        </div>
        <div v-if="overview.platforms.length" class="web-control-instance-list">
          <article v-for="item in overview.platforms" :key="item.platform_id" class="web-control-instance">
            <div>
              <span class="web-control-instance__state" :data-connected="item.connected"></span>
              <strong>{{ item.platform_id }}</strong>
              <span>{{ item.connected ? "桌面端已连接" : "等待桌面端连接" }}</span>
            </div>
            <dl>
              <div><dt>模型</dt><dd>{{ item.selected_model || "未选择" }}</dd></div>
              <div><dt>WebSocket</dt><dd>{{ item.host }}:{{ item.websocket_port }}</dd></div>
              <div><dt>HTTP</dt><dd>{{ item.host }}:{{ item.http_port }}</dd></div>
            </dl>
          </article>
        </div>
        <div v-else class="web-control-empty">尚未发现 AG99live Adapter 实例。请先在 AstrBot 中启用插件并配置平台。</div>
        <div class="web-control-footnote">
          <strong>桌面运行状态</strong>
          <p>本页面可配置 AstrBot 插件参数、Live2D Profile 和动作样例。麦克风、全局按键、Spout/ESP32 及桌面实时动作预览仍由本机运行时持有；它们的 Web 控制桥接尚未完成。</p>
        </div>
      </section>

      <section v-else-if="section === 'settings'" class="web-control-content">
        <div class="web-control-section-heading"><div><p>ADAPTER</p><h2>插件运行参数</h2></div></div>
        <div class="web-control-settings-grid">
          <section class="web-control-settings-group">
            <header><h2>基础身份</h2><span>GENERAL</span></header>
            <label>Client UID<input v-model.trim="settings.general.client_uid" maxlength="128" /></label>
            <label>显示名称<input v-model.trim="settings.general.client_nickname" maxlength="128" /></label>
            <label>对话缓冲条数<input v-model.number="settings.general.chat_buffer_size" type="number" min="1" max="100" /></label>
          </section>
          <section class="web-control-settings-group">
            <header><h2>Live2D 输入</h2><span>MODEL</span></header>
            <label>优先模型<select v-model="settings.live2d_input.model_name"><option value="">自动选择</option><option v-for="name in modelNameOptions" :key="name" :value="name">{{ name }}</option></select></label>
            <label>图片输入冷却（秒）<input v-model.number="settings.live2d_input.image_cooldown_seconds" type="number" min="0" max="86400" /></label>
          </section>
          <section class="web-control-settings-group">
            <header><h2>表演曲线</h2><span>OPTIONAL</span></header>
            <label class="web-control-checkbox"><input v-model="settings.performance_curve.enabled" type="checkbox" />启用独立表演曲线 Provider</label>
            <label>Provider ID<input v-model.trim="settings.performance_curve.provider_id" maxlength="255" :disabled="!settings.performance_curve.enabled" /></label>
          </section>
          <section class="web-control-settings-group">
            <header><h2>语音断句</h2><span>VAD</span></header>
            <label>语音概率阈值<input v-model.number="settings.vad.prob_threshold" type="number" min="0.01" max="1" step="0.01" /></label>
            <label>开始命中帧数<input v-model.number="settings.vad.required_hits" type="number" min="1" max="120" /></label>
            <label>结束静音帧数<input v-model.number="settings.vad.required_misses" type="number" min="1" max="1000" /></label>
          </section>
        </div>
        <div class="web-control-form-actions"><button type="button" :disabled="settingsSaving" @click="void saveSettings()">{{ settingsSaving ? "保存中…" : "保存设置" }}</button></div>
      </section>

      <section v-else-if="section === 'profile'" class="web-control-content">
        <div class="web-control-section-heading">
          <div><p>LIVE2D / CAPABILITIES</p><h2>语义轴 Profile</h2></div>
          <label v-if="profileModels.length" class="web-control-model-picker"><span>模型</span><select v-model="selectedModelName"><option v-for="item in profileModels" :key="item.name" :value="item.name">{{ item.name }}</option></select></label>
        </div>
        <SemanticAxisProfileEditor
          v-if="profile"
          :current-profile="profile"
          :selected-model-name="selectedModelName"
          :latest-save-result="profileSaveResult"
          @save-semantic-axis-profile="saveProfile"
        />
        <div v-else class="web-control-empty">当前模型没有可编辑的 Semantic Axis Profile。</div>
      </section>

      <section v-else class="web-control-content">
        <div class="web-control-section-heading"><div><p>MOTION / REFERENCES</p><h2>动作样例与 Prompt 参考</h2></div></div>
        <p v-if="motionTuningStatus.rootError || motionTuningStatus.loadError" class="web-control-inline-error">{{ motionTuningStatus.rootError || motionTuningStatus.loadError }}</p>
        <MotionTuningPanel
          :semantic-profile="profile"
          :motion-playback-records="[]"
          :motion-tuning-samples="motionTuningSamples"
          :motion-tuning-samples-status="motionTuningStatus"
          :effective-examples="motionTuningStatus.effectiveExamples"
          @request-motion-tuning-samples-sync="void loadSamples()"
          @preview-compiled-semantic-motion="previewUnavailable"
          @preview-recorded-parameter-plan="previewRecordedUnavailable"
          @save-motion-tuning-sample="saveSample"
          @delete-motion-tuning-sample="deleteSample"
        />
      </section>
    </section>
  </main>
</template>
