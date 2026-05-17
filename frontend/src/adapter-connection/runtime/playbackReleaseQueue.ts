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

export function queueAssistantTextForPlayback(
  pendingAssistantTexts: Map<string, PendingAssistantTextItem>,
  text: string,
  turnId: string | null,
  messageId: string,
): void {
  pendingAssistantTexts.set(messageId, {
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
  pendingAudios.set(messageId, {
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
