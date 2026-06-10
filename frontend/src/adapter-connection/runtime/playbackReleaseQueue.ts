/**
 * pending 文本/音频队列的 key、增删查工具。
 *
 * 队列的 key 必须能区分"同一个 messageId 在不同 turn 下"的情况
 * （后端在不同轮次里复用相同 messageId 时仍然要相互隔离），所以这里把
 * (turnId, messageId) 编码成形如 `${len}:${turnId}:${messageId}` 的复合串：
 *   - 用 turnId 长度做前缀，避免 turnId 含冒号或恰好等于另一个 messageId 时撞 key；
 *   - 空 turnId 被 normalizeTurnIdForComparison 规范化为空串（仍能稳定参与组合）。
 * matchesPlaybackGroup 单独提供"两个 turnId 是否同一轮次"的语义判定。
 *
 * 本文件是纯工具：不持有 Map，由调用方在自己的 state 上持有 pending 容器。
 */

export interface PendingPlaybackItem {
  turnId: string | null;
  messageId: string;
  receivedAtMs: number;
}

export interface PendingAssistantTextItem extends PendingPlaybackItem {
  text: string;
}

export interface PendingAudioItem extends PendingPlaybackItem {
  audioUrl: string;
}

/**
 * 构造 pending 队列里一项的稳定 key：`${len}:${turnId}:${messageId}`。
 * 用 turnId 长度前缀防止 turnId 与 messageId 边界歧义；空 turnId 视作长度 0 的串。
 */
export function buildPendingPlaybackKey(
  turnId: string | null,
  messageId: string,
): string {
  const normalizedTurnId = normalizeTurnIdForComparison(turnId);
  const normalizedMessageId = messageId.trim();
  return `${normalizedTurnId.length}:${normalizedTurnId}:${normalizedMessageId}`;
}

export function getPendingPlaybackItem<TItem extends PendingPlaybackItem>(
  pendingItems: Map<string, TItem>,
  turnId: string | null,
  messageId: string,
): TItem | undefined {
  return pendingItems.get(buildPendingPlaybackKey(turnId, messageId));
}

export function deletePendingPlaybackItem<TItem extends PendingPlaybackItem>(
  pendingItems: Map<string, TItem>,
  turnId: string | null,
  messageId: string,
): boolean {
  return pendingItems.delete(buildPendingPlaybackKey(turnId, messageId));
}

export function queueAssistantTextForPlayback(
  pendingAssistantTexts: Map<string, PendingAssistantTextItem>,
  text: string,
  turnId: string | null,
  messageId: string,
): void {
  pendingAssistantTexts.set(buildPendingPlaybackKey(turnId, messageId), {
    text,
    turnId,
    messageId,
    receivedAtMs: performance.now(),
  });
}

export function queueAudioForPlayback(
  pendingAudios: Map<string, PendingAudioItem>,
  audioUrl: string,
  turnId: string | null,
  messageId: string,
): void {
  pendingAudios.set(buildPendingPlaybackKey(turnId, messageId), {
    audioUrl,
    turnId,
    messageId,
    receivedAtMs: performance.now(),
  });
}

/**
 * 两个 turnId 是否属于同一播放组：两侧都得是非空串且规范化后相等。
 * 任一为空都返回 false（不把"无主"的项当作组成员）。
 */
export function matchesPlaybackGroup(
  itemTurnId: string | null,
  targetTurnId: string | null,
): boolean {
  const normalizedItemTurnId = normalizeTurnIdForComparison(itemTurnId);
  const normalizedTargetTurnId = normalizeTurnIdForComparison(targetTurnId);
  return Boolean(
    normalizedItemTurnId
    && normalizedTargetTurnId
    && normalizedItemTurnId === normalizedTargetTurnId,
  );
}

function normalizeTurnIdForComparison(value: string | null): string {
  return typeof value === "string" ? value.trim() : "";
}
