<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type {
  DesktopBackendHistoryMessage,
  DesktopBackendHistorySummary,
} from "../types/desktop";
import { formatReportedAt } from "./desktopSettings";

const props = defineProps<{
  histories: DesktopBackendHistorySummary[];
  messages: DesktopBackendHistoryMessage[];
  activeHistoryUid: string;
  viewedHistoryUid: string;
  busy: boolean;
  available: boolean;
  error: string;
  notice: string;
}>();
const emit = defineEmits<{
  refresh: [];
  create: [];
  view: [uid: string];
  load: [uid: string];
  delete: [uid: string];
}>();

const PAGE_SIZE = 100;
const historyPage = ref(0);
const messagePage = ref(0);
const deleteConfirmationUid = ref("");
const cancelDeleteButton = ref<HTMLButtonElement | null>(null);
const deleteButton = ref<HTMLButtonElement | null>(null);
const disabled = computed(() => props.busy || !props.available);
const historyPageCount = computed(() => Math.max(1, Math.ceil(props.histories.length / PAGE_SIZE)));
const messagePageCount = computed(() => Math.max(1, Math.ceil(props.messages.length / PAGE_SIZE)));
const visibleHistories = computed(() => props.histories.slice(
  historyPage.value * PAGE_SIZE,
  (historyPage.value + 1) * PAGE_SIZE,
));
const visibleMessages = computed(() => {
  const end = Math.max(0, props.messages.length - messagePage.value * PAGE_SIZE);
  return props.messages.slice(Math.max(0, end - PAGE_SIZE), end).reverse();
});
const messageRange = computed(() => {
  if (!props.messages.length) return "0 条消息";
  const end = Math.max(0, props.messages.length - messagePage.value * PAGE_SIZE);
  const start = Math.max(0, end - PAGE_SIZE) + 1;
  return `第 ${start}-${end} 条 / 共 ${props.messages.length} 条`;
});

watch(historyPageCount, (count) => {
  historyPage.value = Math.min(historyPage.value, count - 1);
});
watch(messagePageCount, (count) => {
  messagePage.value = Math.min(messagePage.value, count - 1);
});
watch(() => props.viewedHistoryUid, () => {
  messagePage.value = 0;
  deleteConfirmationUid.value = "";
});
watch(() => props.activeHistoryUid, () => {
  deleteConfirmationUid.value = "";
});

function viewHistory(uid: string): void {
  if (!disabled.value && uid !== props.viewedHistoryUid) emit("view", uid);
}

function loadHistory(uid: string): void {
  if (disabled.value || uid === props.activeHistoryUid) return;
  if (window.confirm("载入此会话后，桌宠的后续对话将使用这段历史。继续载入？")) {
    emit("load", uid);
  }
}

async function beginDelete(): Promise<void> {
  if (disabled.value || !props.viewedHistoryUid) return;
  deleteConfirmationUid.value = props.viewedHistoryUid;
  await nextTick();
  cancelDeleteButton.value?.focus();
}

async function cancelDelete(): Promise<void> {
  deleteConfirmationUid.value = "";
  await nextTick();
  deleteButton.value?.focus();
}

function confirmDelete(): void {
  const uid = deleteConfirmationUid.value;
  if (disabled.value || !uid || uid !== props.viewedHistoryUid) return;
  deleteConfirmationUid.value = "";
  emit("delete", uid);
}

function messageRole(message: DesktopBackendHistoryMessage): string {
  if (message.type === "tool_call_status") return "system";
  return message.role === "human" ? "user" : message.role === "ai" ? "assistant" : "system";
}

function messageLabel(message: DesktopBackendHistoryMessage): string {
  if (message.type === "tool_call_status") return message.toolName ? `工具：${message.toolName}` : "工具";
  if (message.role === "human") return "用户";
  if (message.role === "ai") return message.name?.trim() || "助手";
  return "系统";
}
</script>

<template>
  <div class="web-history" :aria-busy="busy">
    <div class="web-history__toolbar">
      <span class="web-history__status" role="status">{{ busy ? "正在处理…" : `${histories.length} 个会话` }}</span>
      <button type="button" :disabled="disabled" @click="emit('refresh')">刷新</button>
      <button type="button" class="web-history__primary" :disabled="disabled" @click="emit('create')">新建会话</button>
    </div>
    <p v-if="error" class="web-history__error" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="web-history__notice" role="status">{{ notice }}</p>
    <p v-if="!available" class="web-history__empty">当前没有可用的桌宠实例（Adapter）。</p>

    <div class="web-history__columns">
      <section class="web-history__sessions" aria-labelledby="web-history-sessions-heading">
        <header class="web-history__heading">
          <h2 id="web-history-sessions-heading">会话</h2>
          <span v-if="historyPageCount > 1">{{ historyPage + 1 }} / {{ historyPageCount }}</span>
        </header>
        <ul class="web-history__list">
          <li
            v-for="history in visibleHistories"
            :key="history.uid"
            class="web-history__session"
            :data-viewed="history.uid === viewedHistoryUid"
            :aria-current="history.uid === viewedHistoryUid ? 'true' : undefined"
          >
            <div class="web-history__session-meta">
              <strong>{{ history.uid === activeHistoryUid ? "当前会话" : "历史会话" }}</strong>
              <time v-if="formatReportedAt(history.timestamp)" :datetime="history.timestamp">{{ formatReportedAt(history.timestamp) }}</time>
            </div>
            <p class="web-history__preview">{{ history.latestMessage?.content || "空白会话" }}</p>
            <span class="web-history__uid">{{ history.uid }}</span>
            <div class="web-history__session-actions">
              <button
                type="button"
                :disabled="disabled || history.uid === viewedHistoryUid"
                :aria-label="`查看会话 ${history.uid}`"
                @click="viewHistory(history.uid)"
              >{{ history.uid === viewedHistoryUid ? "正在查看" : "查看" }}</button>
              <button
                type="button"
                :disabled="disabled || history.uid === activeHistoryUid"
                :aria-label="`载入会话 ${history.uid}`"
                @click="loadHistory(history.uid)"
              >{{ history.uid === activeHistoryUid ? "当前已载入" : "载入会话" }}</button>
            </div>
          </li>
        </ul>
        <p v-if="!histories.length && available" class="web-history__empty">{{ busy ? "正在读取会话…" : "暂无会话。" }}</p>
        <nav v-if="historyPageCount > 1" class="web-history__pagination" aria-label="会话列表分页">
          <button type="button" :disabled="busy || historyPage === 0" @click="historyPage -= 1">上一页</button>
          <button type="button" :disabled="busy || historyPage + 1 >= historyPageCount" @click="historyPage += 1">下一页</button>
        </nav>
      </section>

      <section class="web-history__messages" aria-labelledby="web-history-messages-heading">
        <header class="web-history__heading">
          <div>
            <h2 id="web-history-messages-heading">{{ viewedHistoryUid ? "会话消息" : "未选择会话" }}</h2>
            <span v-if="viewedHistoryUid" class="web-history__uid">{{ viewedHistoryUid }}</span>
          </div>
          <button
            v-if="viewedHistoryUid"
            ref="deleteButton"
            type="button"
            class="web-history__danger"
            :disabled="disabled"
            @click="beginDelete"
          >删除此会话</button>
        </header>
        <div
          v-if="deleteConfirmationUid"
          class="web-history__confirmation"
          role="dialog"
          aria-labelledby="web-history-delete-heading"
          aria-describedby="web-history-delete-description"
          @keydown.esc.prevent.stop="cancelDelete"
        >
          <strong id="web-history-delete-heading">确认删除此会话？</strong>
          <p id="web-history-delete-description">{{ deleteConfirmationUid === activeHistoryUid ? "当前正在使用的会话将被删除。" : "这段历史将被删除。" }}此操作无法撤销。</p>
          <div class="web-history__session-actions">
            <button ref="cancelDeleteButton" type="button" @click="cancelDelete">取消</button>
            <button type="button" class="web-history__danger" :disabled="disabled" @click="confirmDelete">确认删除</button>
          </div>
        </div>
        <p v-if="viewedHistoryUid" class="web-history__status">{{ messageRange }}</p>
        <ol class="web-history__list">
          <li v-for="message in visibleMessages" :key="message.id" class="web-history__message" :data-role="messageRole(message)">
            <header class="web-history__message-meta">
              <strong>{{ messageLabel(message) }}</strong>
              <time v-if="formatReportedAt(message.timestamp)" :datetime="message.timestamp">{{ formatReportedAt(message.timestamp) }}</time>
            </header>
            <p class="web-history__message-content">{{ message.content || "（无文本内容）" }}</p>
            <span v-if="message.type === 'tool_call_status' && message.status" class="web-history__status">{{ message.status }}</span>
          </li>
        </ol>
        <p v-if="!messages.length && available" class="web-history__empty">{{ viewedHistoryUid ? (busy ? "正在读取消息…" : "这段会话还没有消息。") : "尚未选择会话。" }}</p>
        <nav v-if="messagePageCount > 1" class="web-history__pagination" aria-label="会话消息分页">
          <button type="button" :disabled="busy || messagePage === 0" @click="messagePage -= 1">较新消息</button>
          <button type="button" :disabled="busy || messagePage + 1 >= messagePageCount" @click="messagePage += 1">较早消息</button>
        </nav>
      </section>
    </div>
  </div>
</template>

<style scoped>
.web-history {
  min-width: 0;
  color: var(--ink-main);
  font-size: 13px;
  letter-spacing: 0;
}

.web-history button {
  min-height: 36px;
  max-width: 100%;
  padding: 7px 12px;
  border: 1px solid var(--wc-border);
  border-radius: 5px;
  background: var(--wc-surface-raised);
  color: var(--ink-strong);
  cursor: pointer;
  overflow-wrap: anywhere;
}

.web-history button:hover:not(:disabled) {
  border-color: var(--wc-accent);
}

.web-history button:focus-visible {
  outline: 2px solid var(--wc-accent);
  outline-offset: 3px;
}

.web-history button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.web-history button.web-history__primary {
  border-color: var(--wc-accent);
  background: var(--wc-accent);
  color: var(--wc-accent-ink);
}

.web-history button.web-history__danger {
  border-color: var(--wc-danger-border);
  background: var(--wc-danger-bg);
  color: var(--wc-danger-ink);
}

.web-history__toolbar,
.web-history__heading,
.web-history__session-meta,
.web-history__message-meta,
.web-history__session-actions,
.web-history__pagination {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  min-width: 0;
}

.web-history__toolbar {
  min-height: 52px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--wc-border);
}

.web-history__toolbar > .web-history__status {
  flex: 1 1 140px;
}

.web-history__columns {
  display: grid;
  grid-template-columns: minmax(240px, 0.8fr) minmax(0, 1.7fr);
  align-items: start;
  gap: 26px;
  margin-top: 22px;
}

.web-history__sessions,
.web-history__messages {
  min-width: 0;
}

.web-history__messages {
  padding-left: 26px;
  border-left: 1px solid var(--wc-border-soft);
}

.web-history__heading {
  justify-content: space-between;
  min-height: 44px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--wc-border);
}

.web-history__heading > div {
  min-width: 0;
  flex: 1 1 200px;
}

.web-history__heading h2 {
  margin: 0;
  color: var(--ink-strong);
  font-size: 16px;
}

.web-history__list {
  padding: 0;
  margin: 0;
  list-style: none;
}

.web-history__session {
  padding: 16px 10px;
  border-bottom: 1px solid var(--wc-border-soft);
}

.web-history__session[data-viewed="true"] {
  background: var(--wc-accent-soft);
  box-shadow: inset 3px 0 var(--wc-accent);
}

.web-history__session-meta,
.web-history__message-meta {
  justify-content: space-between;
  align-items: start;
}

.web-history__session-meta strong,
.web-history__message-meta strong {
  min-width: 0;
  color: var(--ink-strong);
  overflow-wrap: anywhere;
}

.web-history time,
.web-history__status,
.web-history__uid {
  color: var(--ink-soft);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.web-history__uid {
  display: block;
  margin-top: 6px;
}

.web-history__preview {
  display: -webkit-box;
  margin: 10px 0 8px;
  overflow: hidden;
  line-height: 1.6;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.web-history__session-actions {
  margin-top: 12px;
}

.web-history__message {
  padding: 18px 0;
  border-bottom: 1px solid var(--wc-border-soft);
}

.web-history__message[data-role="user"] .web-history__message-meta strong {
  color: var(--wc-accent);
}

.web-history__message[data-role="system"] .web-history__message-meta strong {
  color: var(--amber);
}

.web-history__message-content {
  margin: 10px 0 0;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.web-history__message > .web-history__status {
  display: block;
  margin-top: 8px;
}

.web-history__pagination {
  justify-content: space-between;
  min-height: 56px;
  margin-top: 12px;
}

.web-history__confirmation {
  padding: 14px;
  margin-top: 14px;
  border: 1px solid var(--wc-danger-border);
  border-radius: 5px;
  background: var(--wc-danger-bg);
  color: var(--wc-danger-ink);
  overflow-wrap: anywhere;
}

.web-history__confirmation p {
  margin: 8px 0;
  line-height: 1.6;
}

.web-history__empty,
.web-history__notice,
.web-history__error {
  margin: 14px 0;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.web-history__empty {
  color: var(--ink-soft);
}

.web-history__notice {
  color: var(--wc-accent);
}

.web-history__error {
  color: var(--wc-danger-ink);
}

@media (max-width: 900px) {
  .web-history__columns {
    grid-template-columns: minmax(0, 1fr);
    gap: 24px;
  }

  .web-history__messages {
    padding-left: 0;
    border-left: 0;
  }
}
</style>
