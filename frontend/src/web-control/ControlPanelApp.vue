<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import MotionTuningPanel from "../components/MotionTuningPanel.vue";
import SemanticAxisProfileEditor from "../components/SemanticAxisProfileEditor.vue";
import SettingsForm from "./SettingsForm.vue";
import DesktopSettingsPanel from "./DesktopSettingsPanel.vue";
import { useParameterExcludeKeywords } from "../action-lab/parameterExcludeKeywords";
import {
  desktopErrorMessage,
  type DesktopSettingsQueryResponse,
  type DesktopSettingsState,
} from "./desktopSettings";
import {
  CONFIG_ERROR_FALLBACKS,
  writeField,
  type ConfigField,
  type ConfigSection,
  type ConfigSchemaResponse,
  type ConfigValues,
  type ProviderOption,
  type SettingsSaveResponse,
} from "./configSchema";
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
type AdapterSummary = {
  platform_id: string;
  host: string;
  websocket_port: number;
  http_port: number;
  speaker_name: string;
  auto_start_mic: boolean;
  connected: boolean;
  selected_model: string;
  available_models: string[];
};
type OverviewResponse = { platforms: AdapterSummary[] };
type ProfileResponse = {
  model_name: string;
  profile: SemanticAxisProfile;
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
const profileSaveResult = ref<DesktopSemanticAxisProfileSaveResult | null>(null);
const motionTuningSamples = ref<DesktopMotionTuningSample[]>([]);
const motionTuningStatus = ref<DesktopMotionTuningSamplesStatus>({
  rootError: "",
  loadError: "",
  diagnostics: [],
  effectiveExamples: [],
});
const settings = ref<ConfigValues>({});
const savedSettings = ref<ConfigValues>({});
const configSections = ref<ConfigSection[]>([]);
const configDefaults = ref<ConfigValues>({});
const configProviders = ref<ProviderOption[]>([]);
const settingsFieldError = ref("");
const settingsFieldErrorCode = ref("");
const desktopSettings = ref<DesktopSettingsState>({
  connected: false,
  connectionRevision: 0,
  platformId: "",
  settings: {},
});
const desktopBusyCount = ref(0);
const desktopBusy = computed(() => desktopBusyCount.value > 0);
const desktopError = ref("");
const {
  excludedParameterKeywordsText,
  persistParameterExcludeKeywords,
  resetParameterExcludeKeywords,
} = useParameterExcludeKeywords();

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
    await loadConfigSchema();
    await loadSettings();
    await loadDesktopSettings();
    if (selectedPlatformId.value) {
      await Promise.all([loadProfile(), loadSamples()]);
    }
  } catch (error) {
    showError(error);
  } finally {
    isLoading.value = false;
  }
}
async function loadConfigSchema(): Promise<void> {
  const response = await apiGet<ConfigSchemaResponse>("control/config/schema");
  configSections.value = response.sections;
  configDefaults.value = response.defaults;
  configProviders.value = response.providers;
}

async function loadSettings(): Promise<void> {
  const response = await apiGet<{ settings: ConfigValues }>("control/settings");
  const next: ConfigValues = JSON.parse(JSON.stringify(configDefaults.value));
  for (const [section, fields] of Object.entries(response.settings)) {
    next[section] = { ...(next[section] ?? {}), ...fields };
  }
  settings.value = next;
  savedSettings.value = JSON.parse(JSON.stringify(next));
  settingsFieldError.value = "";
  settingsFieldErrorCode.value = "";
}

function applyFieldChange(path: string, value: string | number | boolean): void {
  writeField(settings.value, path, value);
  if (settingsFieldError.value) {
    settingsFieldError.value = "";
    settingsFieldErrorCode.value = "";
  }
}

const settingsDirty = computed(() => {
  const current = settings.value;
  const saved = savedSettings.value;
  return Object.keys(current).some(
    (section) =>
      Object.keys(current[section] ?? {}).some(
        (key) => current[section][key] !== saved[section]?.[key],
      ),
  );
});

async function saveSettings(): Promise<void> {
  settingsSaving.value = true;
  resetMessage();
  try {
    const response = await apiPost<SettingsSaveResponse>("control/settings", {
      settings: JSON.parse(JSON.stringify(settings.value)),
    });
    if (!response.ok) {
      settingsFieldError.value = response.error?.field ?? "";
      settingsFieldErrorCode.value = response.error?.code ?? "settings_value_invalid";
      pageError.value = "";
      pageNotice.value = "";
      if (!settingsFieldError.value) {
        pageError.value = message(
          `errors.${settingsFieldErrorCode.value}`,
          "配置未被保存。",
        );
      }
      return;
    }
    if (response.settings) {
      settings.value = JSON.parse(JSON.stringify(response.settings));
      savedSettings.value = JSON.parse(JSON.stringify(response.settings));
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

function message(key: string, fallback: string): string {
  const bridge = window.AstrBotPluginView;
  const short = key.startsWith("errors.") ? key.slice("errors.".length) : key;
  const localized = bridge ? bridge.t(key, "") : "";
  if (localized) return localized;
  return CONFIG_ERROR_FALLBACKS[short] ?? fallback;
}

function labelFor(field: ConfigField): string {
  const bridge = window.AstrBotPluginView;
  const localized = bridge ? bridge.t(`views.control-panel.fields.${field.key}`, "") : "";
  return localized || field.label;
}

function descriptionFor(field: ConfigField): string {
  const bridge = window.AstrBotPluginView;
  const localized = bridge ? bridge.t(`views.control-panel.fields.${field.key}.hint`, "") : "";
  return localized || field.description;
}

const desktopSettingEntries = computed(() =>
  Object.values(desktopSettings.value.settings).sort((a, b) => a.order - b.order),
);

async function loadDesktopSettings(): Promise<void> {
  desktopError.value = "";
  if (!selectedPlatformId.value) {
    desktopSettings.value = {
      connected: false,
      connectionRevision: 0,
      platformId: "",
      settings: {},
    };
    return;
  }
  const platformId = selectedPlatformId.value;
  const wasConnected = desktopSettings.value.platformId === platformId
    && desktopSettings.value.connected;
  try {
    const next = await apiGet<DesktopSettingsState>("control/desktop/settings", {
      platform_id: platformId,
    });
    if (selectedPlatformId.value !== platformId) return;
    const current = desktopSettings.value;
    const samePlatform = current.platformId === platformId;
    const useObservedConnection = !samePlatform
      || next.connectionRevision >= current.connectionRevision;
    desktopSettings.value = {
      connected: useObservedConnection ? next.connected : current.connected,
      connectionRevision: samePlatform
        ? Math.max(current.connectionRevision, next.connectionRevision)
        : next.connectionRevision,
      platformId,
      settings: mergeDesktopSettings(next.settings, platformId),
    };
    if (!wasConnected && desktopSettings.value.connected) {
      await refreshDesktopSettings(platformId);
    }
  } catch (error) {
    if (selectedPlatformId.value === platformId) {
      desktopError.value = desktopErrorMessage(error instanceof Error ? error.message : "");
    }
  }
}

async function queryDesktopSetting(
  key: string,
  action: "list" | "set",
  value?: string,
): Promise<void> {
  if (!selectedPlatformId.value) return;
  const platformId = selectedPlatformId.value;
  desktopBusyCount.value += 1;
  desktopError.value = "";
  let rejectedError = "";
  let relatedKey = "";
  try {
    const response = await apiPost<DesktopSettingsQueryResponse>(
      "control/desktop/settings",
      { platform_id: platformId, key, action, value },
    );
    if (selectedPlatformId.value !== platformId) return;
    const current = desktopSettings.value;
    const samePlatform = current.platformId === platformId;
    const useObservedConnection = !samePlatform
      || response.connectionRevision >= current.connectionRevision;
    desktopSettings.value = {
      connected: useObservedConnection ? response.connected : current.connected,
      connectionRevision: samePlatform
        ? Math.max(current.connectionRevision, response.connectionRevision)
        : response.connectionRevision,
      platformId,
      settings: mergeDesktopSettings(
        response.key && response.settings?.[response.key]
          ? { [response.key]: response.settings[response.key] }
          : response.settings ?? desktopSettings.value.settings,
      ),
    };
    if (!response.ok) {
      rejectedError = desktopErrorMessage(response.error?.code);
      desktopError.value = rejectedError;
    } else if (action === "set") {
      relatedKey = relatedDesktopSettingKey(key);
    }
  } catch (error) {
    if (selectedPlatformId.value === platformId) {
      desktopError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    desktopBusyCount.value -= 1;
  }
  if (rejectedError && action === "set" && selectedPlatformId.value === platformId) {
    await refreshDesktopSettings(platformId);
    desktopError.value = rejectedError;
  } else if (relatedKey && selectedPlatformId.value === platformId) {
    await queryDesktopSettingForPlatform(relatedKey, "list", platformId);
  }
}

function relatedDesktopSettingKey(key: string): string {
  switch (key) {
    case "esp32_display_crop_x": return "esp32_display_crop_w";
    case "esp32_display_crop_y": return "esp32_display_crop_h";
    case "esp32_display_crop_w": return "esp32_display_crop_x";
    case "esp32_display_crop_h": return "esp32_display_crop_y";
    default: return "";
  }
}

async function refreshDesktopSettings(platformId = selectedPlatformId.value): Promise<void> {
  if (!platformId || selectedPlatformId.value !== platformId) return;
  await Promise.all(
    desktopSettingEntries.value.map((entry) =>
      queryDesktopSettingForPlatform(entry.key, "list", platformId),
    ),
  );
}

async function queryDesktopSettingForPlatform(
  key: string,
  action: "list" | "set",
  platformId: string,
  value?: string,
): Promise<void> {
  if (selectedPlatformId.value !== platformId) return;
  await queryDesktopSetting(key, action, value);
}

function mergeDesktopSettings(
  nextSettings: DesktopSettingsState["settings"],
  platformId = selectedPlatformId.value,
): DesktopSettingsState["settings"] {
  if (desktopSettings.value.platformId !== platformId) return { ...nextSettings };
  const merged = { ...desktopSettings.value.settings };
  for (const [key, next] of Object.entries(nextSettings)) {
    const current = merged[key];
    const nextTime = Date.parse(next.reportedAt);
    const currentTime = current ? Date.parse(current.reportedAt) : Number.NaN;
    if (
      !current
      || (Number.isFinite(nextTime)
        && (!Number.isFinite(currentTime) || nextTime >= currentTime))
    ) {
      merged[key] = next;
    }
  }
  return merged;
}

// The desktop client restarts on its own schedule, so a one-shot read goes
// stale within seconds. Poll only while the section that shows it is open.
const DESKTOP_STATE_POLL_MS = 8000;
let desktopPollTimer: ReturnType<typeof setInterval> | null = null;

function stopDesktopPolling(): void {
  if (desktopPollTimer !== null) {
    clearInterval(desktopPollTimer);
    desktopPollTimer = null;
  }
}

function startDesktopPolling(): void {
  stopDesktopPolling();
  if (section.value !== "settings" || desktopBusy.value) return;
  desktopPollTimer = setInterval(() => {
    if (!document.hidden && !desktopBusy.value) void loadDesktopSettings();
  }, DESKTOP_STATE_POLL_MS);
}

watch(section, () => {
  if (section.value === "settings") void loadDesktopSettings();
  startDesktopPolling();
});

onBeforeUnmount(stopDesktopPolling);

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
              <div><dt>说话人</dt><dd>{{ item.speaker_name || "AstrBot" }}</dd></div>
              <div><dt>自动开麦</dt><dd>{{ item.auto_start_mic ? "已开启" : "已关闭" }}</dd></div>
              <div><dt>WebSocket</dt><dd>{{ item.host }}:{{ item.websocket_port }}</dd></div>
              <div><dt>HTTP</dt><dd>{{ item.host }}:{{ item.http_port }}</dd></div>
            </dl>
          </article>
        </div>
        <div v-else class="web-control-empty">尚未发现 AG99live Adapter 实例。请先在 AstrBot 中启用插件并配置平台。</div>
        <div class="web-control-footnote">
          <strong>桌面运行状态</strong>
          <p>本页面可配置 AstrBot 插件参数、Live2D Profile、动作样例，以及桌面端的截图、按键说话、模型表现、麦克风、Spout 输出和 ESP32 小屏。PTT 按键绑定与桌面实时动作预览仍由本机运行时处理。</p>
        </div>
      </section>

      <section v-else-if="section === 'settings'" class="web-control-content">
        <div class="web-control-section-heading"><div><p>ADAPTER</p><h2>插件运行参数</h2></div></div>
        <SettingsForm
          :sections="configSections"
          :values="settings"
          :providers="configProviders"
          :models="modelNameOptions"
          :field-error-path="settingsFieldError"
          :field-error-code="settingsFieldErrorCode"
          :disabled="settingsSaving"
          :label-for="labelFor"
          :description-for="descriptionFor"
          :message="message"
          @change="applyFieldChange"
        />
        <DesktopSettingsPanel
          :settings="desktopSettingEntries"
          :connected="desktopSettings.connected"
          :busy="desktopBusy"
          :error="desktopError"
          :on-refresh="refreshDesktopSettings"
          :on-apply="(key, value) => queryDesktopSetting(key, 'set', value)"
        />
        <div class="web-control-form-actions">
          <span class="web-control-form-actions__status">
            {{ settingsDirty ? "有未保存的修改" : "配置已与 AstrBot 同步" }}
          </span>
          <button type="button" :disabled="settingsSaving || !settingsDirty" @click="void saveSettings()">
            {{ settingsSaving ? "保存中…" : "保存设置" }}
          </button>
        </div>
      </section>

      <section v-else-if="section === 'profile'" class="web-control-content">
        <div class="web-control-section-heading">
          <div><p>LIVE2D / CAPABILITIES</p><h2>语义轴 Profile</h2></div>
          <label v-if="modelNameOptions.length" class="web-control-model-picker">
            <span>模型</span>
            <select v-model="selectedModelName">
              <option v-for="name in modelNameOptions" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
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
        <section class="web-control-settings-group web-control-action-preferences">
          <header>
            <h2>动作参数过滤</h2>
            <span>LOCAL</span>
          </header>
          <p class="web-control-settings-group__description">
            仅影响此 Web 控制页与动作实验室的参数筛选，不会修改模型 Profile 或桌面运行时。
          </p>
          <label class="web-control-field">
            <span class="web-control-field__label">排除关键词</span>
            <textarea
              v-model="excludedParameterKeywordsText"
              class="web-control-action-preferences__textarea"
              placeholder="hair&#10;bind&#10;physics"
              @change="persistParameterExcludeKeywords"
            />
            <span class="web-control-field__hint">每行一个关键词，也支持逗号分隔；匹配到的参数轴会从实验室筛选结果中隐藏。</span>
          </label>
          <div class="web-control-form-actions">
            <button type="button" class="web-control-refresh" @click="persistParameterExcludeKeywords">应用过滤</button>
            <button type="button" class="web-control-refresh" @click="resetParameterExcludeKeywords">恢复默认</button>
          </div>
        </section>
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
