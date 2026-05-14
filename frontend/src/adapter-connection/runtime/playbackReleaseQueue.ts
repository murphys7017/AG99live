import { normalizeOrchestrationId } from "../core/orchestrationIds.js";

export interface PendingPlaybackItem {
  turnId: string | null;
  orchestrationId: string | null;
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
  orchestrationId: string | null,
  messageId: string,
): void {
  pendingAssistantTexts.set(messageId, {
    text,
    turnId,
    orchestrationId,
    messageId,
    receivedAtMs: performance.now(),
  });
}

export function queueAudioForPlayback(
  pendingAudios: Map<string, PendingAudioItem>,
  audioUrl: string,
  turnId: string | null,
  orchestrationId: string | null,
  messageId: string,
): void {
  pendingAudios.set(messageId, {
    audioUrl,
    turnId,
    orchestrationId,
    messageId,
    receivedAtMs: performance.now(),
  });
}

export function matchesPlaybackGroup(
  itemTurnId: string | null,
  itemOrchestrationId: string | null,
  targetTurnId: string | null,
  targetOrchestrationId: string | null,
): boolean {
  const normalizedItemTurnId = normalizeTurnIdForComparison(itemTurnId);
  const normalizedTargetTurnId = normalizeTurnIdForComparison(targetTurnId);
  if (
    normalizedItemTurnId
    && normalizedTargetTurnId
    && normalizedItemTurnId === normalizedTargetTurnId
  ) {
    return true;
  }
  const normalizedItemOrchestrationId = normalizeOrchestrationId(itemOrchestrationId);
  const normalizedTargetOrchestrationId =
    normalizeOrchestrationId(targetOrchestrationId);
  return Boolean(
    normalizedItemOrchestrationId
    && normalizedTargetOrchestrationId
    && normalizedItemOrchestrationId === normalizedTargetOrchestrationId,
  );
}

function normalizeTurnIdForComparison(value: string | null): string {
  return typeof value === "string" ? value.trim() : "";
}
