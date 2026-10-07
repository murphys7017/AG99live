<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import MotionTuningPanel from "../components/MotionTuningPanel.vue";
import SemanticAxisProfileEditor from "../components/SemanticAxisProfileEditor.vue";
import SettingsForm from "./SettingsForm.vue";
import DesktopSettingsPanel from "./DesktopSettingsPanel.vue";
import HistoryPanel from "./HistoryPanel.vue";
import { useWebHistory } from "./useWebHistory";
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

type ControlSection = "overview" | "settings" | "profile" | "action-lab" | "history";
type AdapterSummary = {
  platform_id: string;
  platform_type: string;
  adapter_display_name: string;
  client_uid: string;
  client_nickname: string;
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
let overviewLoadRevision = 0;
let profileLoadRevision = 0;
let samplesLoadRevision = 0;
const desktopRefreshes = new Map<string, Promise<void>>();
const desktopWriteQueues = new Map<string, Promise<void>>();
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
  history: "对话历史",
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

const history = useWebHistory(selectedPlatformId, computed(() => section.value === "history"), {
  get: apiGet,
  post: apiPost,
});

function showError(error: unknown): void {
  pageError.value = error instanceof Error ? error.message : String(error);
  pageNotice.value = "";
}

function resetMessage(): void {
  pageError.value = "";
  pageNotice.value = "";
}

async function loadOverview(): Promise<void> {
  const revision = ++overviewLoadRevision;
  isLoading.value = true;
  resetMessage();
  try {
    const nextOverview = await apiGet<OverviewResponse>("control/overview");
    if (revision !== overviewLoadRevision) return;
    overview.value = nextOverview;
    if (!overview.value.platforms.some((item) => item.platform_id === selectedPlatformId.value)) {
      selectedPlatformId.value = overview.value.platforms[0]?.platform_id ?? "";
    }
    await loadConfigSchema(revision);
    if (revision !== overviewLoadRevision) return;
    await loadSettings(revision);
    if (revision !== overviewLoadRevision) return;
    await loadDesktopSettings();
    if (revision !== overviewLoadRevision) return;
    if (selectedPlatformId.value) {
      await Promise.all([loadProfile(), loadSamples()]);
      if (revision === overviewLoadRevision && section.value === "history") {
        await history.refresh();
      }
    }
  } catch (error) {
    if (revision === overviewLoadRevision) showError(error);
  } finally {
    if (revision === overviewLoadRevision) isLoading.value = false;
  }
}
async function loadConfigSchema(revision?: number): Promise<void> {
  const response = await apiGet<ConfigSchemaResponse>("control/config/schema");
  if (revision !== undefined && revision !== overviewLoadRevision) return;
  configSections.value = response.sections;
  configDefaults.value = response.defaults;
  configProviders.value = response.providers;
}

async function loadSettings(revision?: number): Promise<void> {
  const response = await apiGet<{ settings: ConfigValues }>("control/settings");
  if (revision !== undefined && revision !== overviewLoadRevision) return;
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
    await Promise.all([loadOverviewSummary(), loadSettings()]);
    if (!pageError.value) {
      pageNotice.value = "AstrBot 插件配置已保存，Adapter 已刷新。";
    }
  } catch (error) {
    showError(error);
  } finally {
    settingsSaving.value = false;
  }
}

async function loadOverviewSummary(): Promise<void> {
  const revision = ++overviewLoadRevision;
  isLoading.value = true;
  try {
    const nextOverview = await apiGet<OverviewResponse>("control/overview");
    if (revision !== overviewLoadRevision) return;
    overview.value = nextOverview;
    if (!overview.value.platforms.some((item) => item.platform_id === selectedPlatformId.value)) {
      selectedPlatformId.value = overview.value.platforms[0]?.platform_id ?? "";
    }
  } finally {
    if (revision === overviewLoadRevision) isLoading.value = false;
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
  } catch (error) {
    if (selectedPlatformId.value === platformId) {
      desktopError.value = desktopErrorMessage(error instanceof Error ? error.message : "");
    }
  }
}

async function listDesktopSettings(platformId = selectedPlatformId.value): Promise<void> {
  if (!platformId || selectedPlatformId.value !== platformId) return;
  const currentRequest = desktopRefreshes.get(platformId);
  if (currentRequest) return currentRequest;

  const request = (async () => {
    try {
      const next = await apiPost<DesktopSettingsState>("control/desktop/settings/list", {
        platform_id: platformId,
      });
      if (selectedPlatformId.value !== platformId) return;
      const current = desktopSettings.value;
      const samePlatform = current.platformId === platformId;
      const useObservedConnection = !samePlatform || next.connectionRevision >= current.connectionRevision;
      desktopSettings.value = {
        connected: useObservedConnection ? next.connected : current.connected,
        connectionRevision: samePlatform
          ? Math.max(current.connectionRevision, next.connectionRevision)
          : next.connectionRevision,
        platformId,
        settings: mergeDesktopSettings(next.settings, platformId),
      };
    } catch (error) {
      if (selectedPlatformId.value === platformId) {
        desktopError.value = desktopErrorMessage(error instanceof Error ? error.message : "");
      }
    }
  })();
  desktopRefreshes.set(platformId, request);
  try {
    await request;
  } finally {
    if (desktopRefreshes.get(platformId) === request) desktopRefreshes.delete(platformId);
  }
}

async function queryDesktopSetting(
  key: string,
  action: "list" | "set",
  value?: string,
  platformId = selectedPlatformId.value,
): Promise<void> {
  if (!platformId) return;
  desktopBusyCount.value += 1;
  if (selectedPlatformId.value === platformId) desktopError.value = "";
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

function queueDesktopWrite(key: string, value: string): void {
  const platformId = selectedPlatformId.value;
  if (!platformId) return;
  const queueKey = JSON.stringify([platformId, key]);
  const previous = desktopWriteQueues.get(queueKey) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => queryDesktopSetting(key, "set", value, platformId))
    .finally(() => {
      if (desktopWriteQueues.get(queueKey) === next) desktopWriteQueues.delete(queueKey);
    });
  desktopWriteQueues.set(queueKey, next);
}

async function refreshDesktopSettings(platformId = selectedPlatformId.value): Promise<void> {
  if (!platformId || selectedPlatformId.value !== platformId) return;
  await listDesktopSettings(platformId);
}

async function queryDesktopSettingForPlatform(
  key: string,
  action: "list" | "set",
  platformId: string,
  value?: string,
): Promise<void> {
  if (selectedPlatformId.value !== platformId) return;
  await queryDesktopSetting(key, action, value, platformId);
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
    if (!document.hidden && !desktopBusy.value) void listDesktopSettings();
  }, DESKTOP_STATE_POLL_MS);
}

function onVisibilityChange(): void {
  if (document.hidden) {
    stopDesktopPolling();
    return;
  }
  if (section.value === "settings") {
    void listDesktopSettings();
    startDesktopPolling();
  }
}

watch(section, () => {
  if (section.value === "settings") void listDesktopSettings();
  startDesktopPolling();
});

onBeforeUnmount(stopDesktopPolling);
onMounted(() => document.addEventListener("visibilitychange", onVisibilityChange));
onBeforeUnmount(() => document.removeEventListener("visibilitychange", onVisibilityChange));

async function loadProfile(): Promise<void> {
  const platformId = selectedPlatformId.value;
  if (!platformId) return;
  const revision = ++profileLoadRevision;
  const modelName = selectedModelName.value || activePlatform.value?.selected_model || "";
  const isCurrent = () => revision === profileLoadRevision
    && selectedPlatformId.value === platformId
    && (selectedModelName.value || activePlatform.value?.selected_model || "") === modelName;
  const query = {
    platform_id: platformId,
    model_name: modelName,
  };
  try {
    const response = await apiGet<ProfileResponse>("control/profile", query);
    if (!isCurrent()) return;
    selectedModelName.value = response.model_name;
    profile.value = response.profile;
  } catch (error) {
    if (!isCurrent()) return;
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
  const platformId = selectedPlatformId.value;
  if (!platformId) return;
  isSaving.value = true;
  resetMessage();
  try {
    const result = await apiPost<DesktopSemanticAxisProfileSaveResult>(
      "control/profile",
      {
        platform_id: platformId,
        request_id: payload.requestId,
        model_name: payload.modelName,
        profile_id: payload.profileId,
        expected_revision: payload.expectedRevision,
        profile: payload.profile,
      },
    );
    if (selectedPlatformId.value !== platformId) return;
    profileSaveResult.value = result;
    await loadProfile();
    pageNotice.value = "Profile 已保存。";
  } catch (error) {
    if (selectedPlatformId.value !== platformId) return;
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
  const platformId = selectedPlatformId.value;
  if (!platformId) return;
  const revision = ++samplesLoadRevision;
  try {
    const response = await apiGet<unknown>("control/samples", {
      platform_id: platformId,
    });
    if (revision !== samplesLoadRevision || selectedPlatformId.value !== platformId) return;
    const normalized = normalizeMotionTuningSamplesStatePayload(response);
    motionTuningSamples.value = normalized.samples;
    motionTuningStatus.value = normalized.status;
  } catch (error) {
    if (revision === samplesLoadRevision && selectedPlatformId.value === platformId) showError(error);
  }
}

async function saveSample(sample: DesktopMotionTuningSample): Promise<void> {
  const platformId = selectedPlatformId.value;
  if (!platformId) return;
  try {
    const response = await apiPost<unknown>("control/samples", {
      platform_id: platformId,
      sample: serializeMotionTuningSample(sample),
    });
    if (selectedPlatformId.value !== platformId) return;
    samplesLoadRevision += 1;
    const normalized = normalizeMotionTuningSamplesStatePayload(response);
    motionTuningSamples.value = normalized.samples;
    motionTuningStatus.value = normalized.status;
    pageNotice.value = "动作样例已保存。";
    pageError.value = "";
  } catch (error) {
    if (selectedPlatformId.value === platformId) showError(error);
  }
}

async function deleteSample(sampleId: string): Promise<void> {
  const platformId = selectedPlatformId.value;
  if (!platformId) return;
  try {
    const response = await apiPost<unknown>("control/samples/delete", {
      platform_id: platformId,
      sample_id: sampleId,
    });
    if (selectedPlatformId.value !== platformId) return;
    samplesLoadRevision += 1;
    const normalized = normalizeMotionTuningSamplesStatePayload(response);
    motionTuningSamples.value = normalized.samples;
    motionTuningStatus.value = normalized.status;
    pageNotice.value = "动作样例已删除。";
    pageError.value = "";
  } catch (error) {
    if (selectedPlatformId.value === platformId) showError(error);
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
  if (next === previous) return;
  profileLoadRevision += 1;
  samplesLoadRevision += 1;
  profile.value = null;
  profileSaveResult.value = null;
  motionTuningSamples.value = [];
  motionTuningStatus.value = {
    rootError: "",
    loadError: "",
    diagnostics: [],
    effectiveExamples: [],
  };
  if (!next) return;
  selectedModelName.value = activePlatform.value?.selected_model ?? "";
  await Promise.all([loadProfile(), loadSamples(), listDesktopSettings(next)]);
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
        <button :aria-current="section === 'history' ? 'page' : undefined" @click="section = 'history'">对话历史</button>
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
            <span>桌宠实例</span>
            <select v-model="selectedPlatformId" aria-label="选择桌宠实例">
              <option v-for="item in overview.platforms" :key="item.platform_id" :value="item.platform_id">
                实例 ID：{{ item.platform_id }} · 客户端：{{ item.client_uid || "未设置" }}
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
          <div><p>STATUS</p><h2>桌宠实例（Adapter）</h2></div>
        </div>
        <div v-if="overview.platforms.length" class="web-control-instance-list">
          <article v-for="item in overview.platforms" :key="item.platform_id" class="web-control-instance">
            <div>
              <span class="web-control-instance__state" :data-connected="item.connected"></span>
              <strong>桌宠实例 ID：{{ item.platform_id }}</strong>
              <span>{{ item.connected ? "桌面端已连接" : "等待桌面端连接" }}</span>
            </div>
            <dl>
              <div><dt>适配器类型</dt><dd>{{ item.adapter_display_name || item.platform_type || "olv_pet_adapter" }} <small>({{ item.platform_type || "olv_pet_adapter" }})</small></dd></div>
              <div><dt>桌面端客户端 ID（会话/发送者）</dt><dd>{{ item.client_uid || "未设置" }}</dd></div>
              <div><dt>桌面端消息显示名</dt><dd>{{ item.client_nickname || "未设置" }}</dd></div>
              <div><dt>模型</dt><dd>{{ item.selected_model || "未选择" }}</dd></div>
              <div><dt>桌宠回复说话人</dt><dd>{{ item.speaker_name || "AstrBot" }}</dd></div>
              <div><dt>自动开麦</dt><dd>{{ item.auto_start_mic ? "已开启" : "已关闭" }}</dd></div>
              <div><dt>WebSocket</dt><dd>{{ item.host }}:{{ item.websocket_port }}</dd></div>
              <div><dt>HTTP</dt><dd>{{ item.host }}:{{ item.http_port }}</dd></div>
            </dl>
          </article>
        </div>
        <div v-else class="web-control-empty">尚未发现 AG99live 桌宠实例（Adapter）。请先在 AstrBot 中启用插件并配置平台。</div>
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
          :on-apply="queueDesktopWrite"
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

      <section v-else-if="section === 'action-lab'" class="web-control-content">
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

      <section v-else-if="section === 'history'" class="web-control-content">
        <HistoryPanel
          :histories="history.histories.value"
          :messages="history.messages.value"
          :active-history-uid="history.activeHistoryUid.value"
          :viewed-history-uid="history.viewedHistoryUid.value"
          :busy="history.busy.value"
          :available="!!selectedPlatformId"
          :error="history.error.value"
          :notice="history.notice.value"
          @refresh="void history.refresh()"
          @create="void history.create()"
          @view="void history.view($event)"
          @load="void history.load($event)"
          @delete="void history.delete($event)"
        />
      </section>
    </section>
  </main>
</template>
