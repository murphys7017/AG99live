<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

type ActiveReading = {
  phase: "ready" | "running" | "paused" | "faulted" | "finished";
  session_id: string;
  revision: number;
  title: string;
  text: string;
  position: number;
  total: number;
  rendered: boolean;
  auto_advance: boolean;
  hold_seconds: number;
  interaction_seconds: number;
  comment_status: string;
  comment: string;
  delivery_turn_id?: string | null;
  error: string | null;
  persistence_pending?: boolean;
  output_status: string;
  pending_position: number | null;
  display_url: string;
};
type ReadingView = ActiveReading | { phase: "empty" | "unavailable"; error?: string };
type ReadingCommand = "start" | "pause" | "previous" | "next" | "comment" | "end" | "retry_persistence";
type ReadingRhythm = Pick<ActiveReading, "auto_advance" | "hold_seconds" | "interaction_seconds">;

const props = defineProps<{ platformId: string }>();
const view = ref<ReadingView>();
const current = computed(() => view.value && "session_id" in view.value ? view.value : null);
const title = ref("");
const text = ref("");
const passages = ref<string[]>([]);
const auto = ref(false);
const hold = ref(25);
const gap = ref(3);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const urlInput = ref<HTMLInputElement>();
const phaseLabels: Record<ActiveReading["phase"], string> = {
  ready: "待开始", running: "共读中", paused: "已暂停", faulted: "异常暂停", finished: "已结束",
};
const commentLabels: Record<string, string> = {
  pending: "待评论", generating: "正在生成或播放", played: "播放完成",
  silent: "已选择静默", rejected: "目标不可用", failed: "失败", unknown: "结果待确认",
};
const outputLabels: Record<string, string> = {
  ready: "角色空闲", busy: "角色忙碌", presentation_offline: "桌面端离线",
  commentary_target_unavailable: "角色暂不支持共读",
  presentation_session_mismatch: "直播配置与桌面端会话不一致",
};
const locked = computed(() => !props.platformId || busy.value || view.value?.phase === "unavailable");
let generation = 0;
let subscription: string | undefined;

function bridge() {
  const result = window.AstrBotPluginView;
  if (!result) throw new Error("请从 AG99live 控制台打开共读。");
  return result;
}

function applyView(next: ReadingView) {
  if ("session_id" in next) {
    const previous = current.value;
    if (previous && next.revision < previous.revision) return;
    const sameSession = previous?.session_id === next.session_id;
    if (!sameSession || auto.value === previous?.auto_advance) auto.value = next.auto_advance;
    if (!sameSession || hold.value === previous?.hold_seconds) hold.value = next.hold_seconds;
    if (!sameSession || gap.value === previous?.interaction_seconds) gap.value = next.interaction_seconds;
  }
  view.value = next;
}

function disconnect() {
  generation += 1;
  if (subscription) {
    void window.AstrBotPluginView?.unsubscribeSSE(subscription).catch(() => {});
    subscription = undefined;
  }
}

async function refresh() {
  disconnect();
  const platform = props.platformId;
  if (!platform) return;
  const attempt = generation;
  error.value = "";
  try {
    const api = bridge();
    await api.ready();
    const params = { platform_id: platform };
    const initial = await api.apiGet<ReadingView>("control/reading/state", params);
    if (attempt !== generation) return;
    applyView(initial);
    const id = await api.subscribeSSE("control/reading/events", {
      onMessage: (event) => {
        if (attempt !== generation) return;
        const state = event.parsed;
        if (!state || typeof state !== "object" || !("phase" in state) || typeof state.phase !== "string") {
          error.value = "共读状态无法读取，请刷新。";
          return;
        }
        applyView(state as ReadingView);
      },
      onError: () => { if (attempt === generation) error.value = "状态连接已断开，请刷新。"; },
      onClose: () => { if (attempt === generation) error.value = "状态连接已断开，请刷新。"; },
    }, params);
    if (attempt !== generation) await api.unsubscribeSSE(id);
    else subscription = id;
  } catch (reason) {
    if (attempt === generation) error.value = reason instanceof Error ? reason.message : String(reason);
  }
}

watch(() => props.platformId, () => {
  view.value = undefined;
  title.value = "";
  text.value = "";
  passages.value = [];
  notice.value = "";
  void refresh();
}, { immediate: true });
watch(text, () => { passages.value = []; });
onBeforeUnmount(disconnect);

async function perform<T>(endpoint: string, data: object): Promise<T | undefined> {
  if (locked.value) return;
  const attempt = generation;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const result = await bridge().apiPost<T>(endpoint, { platform_id: props.platformId, ...data });
    return attempt === generation ? result : undefined;
  } catch (reason) {
    if (attempt === generation) error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    busy.value = false;
  }
}

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 256_000) throw new Error("文件太长，请分成几篇材料。");
    text.value = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    if (!title.value) title.value = file.name.replace(/\.[^.]+$/, "");
    if (text.value.length > 64_000) throw new Error("共读原文最多 64000 个字符。");
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "无法读取 UTF-8 文本。";
  } finally {
    input.value = "";
  }
}

async function preview() {
  const result = await perform<{ passages: string[] }>("control/reading/preview", { text: text.value });
  if (result) passages.value = result.passages;
}

async function save() {
  const next = await perform<ReadingView>("control/reading/material", {
    title: title.value, passages: [...passages.value],
    session_id: current.value?.session_id, revision: current.value?.revision,
  });
  if (next) {
    applyView(next);
    notice.value = "已保存共读材料。";
  }
}

async function command(action: ReadingCommand) {
  const session = current.value;
  if (!session) return;
  const rhythm: Partial<ReadingRhythm> = {};
  if (action === "start") {
    if (auto.value !== session.auto_advance) rhythm.auto_advance = auto.value;
    if (hold.value !== session.hold_seconds) rhythm.hold_seconds = hold.value;
    if (gap.value !== session.interaction_seconds) rhythm.interaction_seconds = gap.value;
  }
  const next = await perform<ReadingView>("control/reading/command", {
    session_id: session.session_id, revision: session.revision, action,
    ...rhythm,
  });
  if (next) applyView(next);
}

async function copyUrl() {
  const url = current.value?.display_url;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    notice.value = "已复制 OBS 共读地址。";
  } catch {
    urlInput.value?.select();
    notice.value = "按 Ctrl+C 复制选中的地址。";
  }
}
</script>

<template>
  <div class="reading-panel">
    <div class="reading-row">
      <button type="button" :disabled="!platformId || busy" @click="refresh">刷新</button>
      <span v-if="current">{{ phaseLabels[current.phase] }} · {{ outputLabels[current.output_status] || current.output_status }}</span>
    </div>
    <p v-if="error || view?.phase === 'unavailable'" role="alert" class="reading-error">{{ error || view?.error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="!platformId">请先选择角色。</p>
    <template v-else-if="view?.phase !== 'unavailable'">
      <details :open="!current">
        <summary>共读材料</summary>
        <label>标题<input v-model="title" maxlength="200" :disabled="locked"></label>
        <label>原文<textarea v-model="text" rows="6" maxlength="64000" :disabled="locked"></textarea></label>
        <div class="reading-row">
          <label class="reading-file">导入 TXT / Markdown<input type="file" accept=".txt,.md,.markdown" :disabled="locked" @change="importFile"></label>
          <button type="button" :disabled="locked || !text.trim()" @click="preview">预览分段</button>
          <button type="button" :disabled="locked || !title.trim() || !passages.length || current?.phase === 'running' || current?.persistence_pending" @click="save">保存材料</button>
        </div>
        <ol v-if="passages.length" class="reading-passages">
          <li v-for="(_, index) in passages" :key="index">
            <textarea v-model="passages[index]" :aria-label="`第 ${index + 1} 段`" rows="3" maxlength="400" :disabled="locked"></textarea>
          </li>
        </ol>
      </details>
      <section v-if="current" class="reading-current">
        <div class="reading-row reading-header">
          <h2>{{ current.title }}</h2>
          <span>{{ current.position }} / {{ current.total }}</span>
        </div>
        <p class="reading-original">{{ current.text }}</p>
        <p v-if="current.comment" class="reading-comment">{{ current.comment }}</p>
        <p role="status">{{ current.rendered ? "OBS 已展示" : "等待 OBS 展示" }} · {{ commentLabels[current.comment_status] || current.comment_status }}</p>
        <p v-if="current.pending_position">本轮结束后切到第 {{ current.pending_position }} 段。</p>
        <p v-if="current.error" class="reading-error" role="alert">{{ current.error === "playback_receipt_unconfirmed" ? "播放回执缺失，本轮结果待确认。" : current.error }}</p>
        <p v-if="current.comment_status === 'unknown' && current.delivery_turn_id">播放轮次 <code>{{ current.delivery_turn_id }}</code></p>
        <label>OBS 共读地址
          <div class="reading-row">
            <input ref="urlInput" :value="current.display_url" readonly @focus="urlInput?.select()">
            <button type="button" :disabled="!current.display_url" @click="copyUrl">复制</button>
          </div>
        </label>
        <div class="reading-row reading-options">
          <label><input v-model="auto" type="checkbox" :disabled="locked"> 自动评论并翻页</label>
          <label>展示停留 <input v-model.number="hold" type="number" min="5" max="300" :disabled="locked"> 秒</label>
          <label>互动窗口 <input v-model.number="gap" type="number" min="1" max="30" :disabled="locked"> 秒</label>
        </div>
        <div v-if="current.persistence_pending" class="reading-row">
          <p class="reading-error" role="alert">共读结果待保存。</p>
          <button type="button" :disabled="locked" @click="command('retry_persistence')">重试保存</button>
        </div>
        <div v-else class="reading-row">
          <button type="button" :disabled="locked || current.phase === 'finished'" @click="command('start')">{{ current.phase === "running" ? "应用节奏" : current.phase === "ready" ? "开始" : "继续" }}</button>
          <button type="button" :disabled="locked || current.phase !== 'running'" @click="command('pause')">暂停</button>
          <button type="button" :disabled="locked || (current.pending_position ?? current.position) <= 1" @click="command('previous')">上一段</button>
          <button type="button" :disabled="locked || (current.pending_position ?? current.position) >= current.total" @click="command('next')">下一段</button>
          <button type="button" :disabled="locked || !current.rendered || current.output_status !== 'ready' || current.phase !== 'running' || current.comment_status === 'generating' || current.pending_position !== null" @click="command('comment')">{{ current.comment_status === "pending" ? "评论当前段" : "再评论一次" }}</button>
          <button type="button" :disabled="locked || current.phase === 'finished'" @click="command('end')">结束</button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.reading-panel, .reading-panel details, .reading-current { display: grid; gap: 12px; }
.reading-panel summary { margin-bottom: 12px; cursor: pointer; }
.reading-panel label { display: grid; gap: 6px; }
.reading-panel input:not([type="checkbox"]), .reading-panel textarea { width: 100%; }
.reading-panel textarea { resize: vertical; }
.reading-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.reading-row > input { flex: 1 1 260px; }
.reading-panel p, .reading-header h2 { margin: 0; }
.reading-header { justify-content: space-between; }
.reading-current { border-top: 1px solid var(--control-border, #47504c); padding-top: 16px; }
.reading-original { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
.reading-comment { border-inline-start: 2px solid currentColor; padding-inline-start: 10px; }
.reading-options label { display: flex; align-items: center; }
.reading-options input[type="number"] { width: 72px; }
.reading-passages { max-height: 24rem; overflow: auto; padding-inline-start: 24px; }
.reading-error { color: var(--control-danger, #f4ac92); }
</style>
