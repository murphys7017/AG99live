export interface SegmentIdentity {
  readonly turnId: string;
  readonly messageId: string;
}

export interface MotionRunIdentity extends SegmentIdentity {
  readonly timelineId: string;
  readonly runId: string;
}

export function normalizeIdentityPart(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function createSegmentIdentity(
  turnId: string | null | undefined,
  messageId: string | null | undefined,
): SegmentIdentity | null {
  const normalizedTurnId = normalizeIdentityPart(turnId);
  const normalizedMessageId = normalizeIdentityPart(messageId);
  if (!normalizedTurnId || !normalizedMessageId) {
    return null;
  }
  return { turnId: normalizedTurnId, messageId: normalizedMessageId };
}

export function requireSegmentIdentity(
  turnId: string | null | undefined,
  messageId: string | null | undefined,
): SegmentIdentity {
  const identity = createSegmentIdentity(turnId, messageId);
  if (!identity) {
    throw new Error("segment_identity_invalid");
  }
  return identity;
}

export function segmentIdentityKey(identity: SegmentIdentity): string {
  return `${identity.turnId.length}:${identity.turnId}:${identity.messageId.length}:${identity.messageId}`;
}

export function sameSegmentIdentity(
  left: SegmentIdentity | null | undefined,
  right: SegmentIdentity | null | undefined,
): boolean {
  return Boolean(
    left
    && right
    && left.turnId === right.turnId
    && left.messageId === right.messageId,
  );
}

export function resolveSessionIdFromIdentity(identity: SegmentIdentity): string {
  return `turn:${identity.turnId}`;
}
