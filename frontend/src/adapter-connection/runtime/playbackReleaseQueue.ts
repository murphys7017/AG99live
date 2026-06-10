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
