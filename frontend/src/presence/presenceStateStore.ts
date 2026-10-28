export type PresenceConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export type PresenceRendererStatus = "idle" | "loading" | "ready" | "error";
export type PresenceConversationPhase =
  | "idle"
  | "preparing"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "settling"
  | "completed"
  | "failed";

export type PresenceMode =
  | "offline"
  | "idle"
  | "noticing"
  | "preparing"
  | "thinking"
  | "speaking"
  | "listening"
  | "interrupted"
  | "settling";

export type PresenceModelState =
  | {
    readonly selection: "none";
    readonly rendererStatus: "idle";
    readonly selectionRevision: number;
  }
  | {
    readonly selection: "selected";
    readonly rendererStatus: "pending" | "loading" | "ready" | "error";
    readonly selectionRevision: number;
  };

export type PresenceMicrophoneState =
  | { readonly status: "quiet" }
  | { readonly status: "capturing"; readonly standby: boolean };

export interface PresenceTransition {
  readonly id: string;
  readonly source:
    | "adapter_connection"
    | "adapter_microphone"
    | "model_sync"
    | "live2d_renderer"
    | "playback_session"
    | "pre_action"
    | "playback_audio"
    | "cursor_gaze";
  readonly type:
    | "connection.changed"
    | "microphone.changed"
    | "model.selection.changed"
    | "model.renderer_status.changed"
    | "conversation.phase.changed"
    | "conversation.preparation.changed"
    | "playback.changed"
    | "attention.changed";
  readonly occurredAtMonotonicMs: number;
}

export interface PresenceSnapshot {
  readonly revision: number;
  readonly updatedAtMonotonicMs: number | null;
  readonly lastTransition: PresenceTransition | null;
  readonly connectionStatus: PresenceConnectionStatus;
  readonly model: PresenceModelState;
  readonly conversationPhase: PresenceConversationPhase;
  readonly playback: "idle" | "speaking";
  readonly microphone: PresenceMicrophoneState;
  readonly attentionTarget: "neutral" | "cursor";
  readonly mode: PresenceMode;
}

export type PresenceEvent =
  | {
    source: "adapter_connection";
    type: "connection.changed";
    status: PresenceConnectionStatus;
  }
  | {
    source: "adapter_microphone";
    type: "microphone.changed";
    capturing: boolean;
    standby: boolean;
  }
  | {
    source: "model_sync";
    type: "model.selection.changed";
    selected: boolean;
    selectionRevision: number;
  }
  | {
    source: "live2d_renderer";
    type: "model.renderer_status.changed";
    status: PresenceRendererStatus;
  }
  | {
    source: "playback_session";
    type: "conversation.phase.changed";
    phase: Exclude<PresenceConversationPhase, "preparing" | "speaking">;
  }
  | {
    source: "pre_action";
    type: "conversation.preparation.changed";
    pending: boolean;
    revision: number;
  }
  | {
    source: "playback_audio";
    type: "playback.changed";
    playing: boolean;
  }
  | {
    source: "cursor_gaze";
    type: "attention.changed";
    active: boolean;
  };

export interface PresenceStateStore {
  dispatch(event: PresenceEvent): Readonly<PresenceSnapshot>;
  getSnapshot(): Readonly<PresenceSnapshot>;
  dispose(): void;
}

export function createPresenceStateStore(options?: {
  onSnapshot?: (snapshot: Readonly<PresenceSnapshot>) => void;
}): PresenceStateStore {
  let disposed = false;
  let latestPreparationRevision = 0;
  let activePreparationRevision: number | null = null;
  let snapshot: Readonly<PresenceSnapshot> = freezeSnapshot({
    revision: 0,
    updatedAtMonotonicMs: null,
    lastTransition: null,
    connectionStatus: "disconnected",
    model: {
      selection: "none",
      rendererStatus: "idle",
      selectionRevision: 0,
    },
    conversationPhase: "idle",
    playback: "idle",
    microphone: { status: "quiet" },
    attentionTarget: "neutral",
    mode: "offline",
  });

  function commit(
    event: PresenceEvent,
    updates: Partial<Omit<PresenceSnapshot, "revision" | "updatedAtMonotonicMs" | "lastTransition" | "mode">>,
  ): Readonly<PresenceSnapshot> {
    const occurredAtMonotonicMs = performance.now();
    const revision = snapshot.revision + 1;
    const next = { ...snapshot, ...updates };
    snapshot = freezeSnapshot({
      ...next,
      revision,
      updatedAtMonotonicMs: occurredAtMonotonicMs,
      lastTransition: {
        id: `presence:${revision}`,
        source: event.source,
        type: event.type,
        occurredAtMonotonicMs,
      },
      mode: deriveMode(next),
    });
    try {
      options?.onSnapshot?.(snapshot);
    } catch {
      console.warn("[PresenceState] Snapshot observer failed.");
    }
    return snapshot;
  }

  function dispatch(event: PresenceEvent): Readonly<PresenceSnapshot> {
    if (disposed) {
      return snapshot;
    }

    switch (event.type) {
      case "connection.changed":
        return event.status === snapshot.connectionStatus
          ? snapshot
          : commit(event, { connectionStatus: event.status });
      case "microphone.changed": {
        const microphone: PresenceMicrophoneState = event.capturing
          ? { status: "capturing", standby: event.standby }
          : { status: "quiet" };
        return sameMicrophone(microphone, snapshot.microphone)
          ? snapshot
          : commit(event, { microphone });
      }
      case "model.selection.changed": {
        if (event.selectionRevision <= snapshot.model.selectionRevision) {
          return snapshot;
        }
        const model: PresenceModelState = event.selected
          ? {
            selection: "selected",
            rendererStatus: "pending",
            selectionRevision: event.selectionRevision,
          }
          : {
            selection: "none",
            rendererStatus: "idle",
            selectionRevision: event.selectionRevision,
          };
        return commit(event, { model });
      }
      case "model.renderer_status.changed": {
        if (snapshot.model.selection === "none") {
          return snapshot;
        }
        const rendererStatus = event.status === "idle" ? "pending" : event.status;
        if (rendererStatus === snapshot.model.rendererStatus) {
          return snapshot;
        }
        return commit(event, {
          model: {
            selection: "selected",
            rendererStatus,
            selectionRevision: snapshot.model.selectionRevision,
          },
        });
      }
      case "conversation.phase.changed":
        if (event.phase === snapshot.conversationPhase) {
          return snapshot;
        }
        return commit(event, {
          conversationPhase: event.phase,
        });
      case "conversation.preparation.changed": {
        if (event.pending) {
          if (event.revision <= latestPreparationRevision) {
            return snapshot;
          }
          latestPreparationRevision = event.revision;
          activePreparationRevision = event.revision;
        } else {
          if (activePreparationRevision !== event.revision) {
            return snapshot;
          }
          activePreparationRevision = null;
        }
        const conversationPhase = resolvePreparationPhase(
          snapshot.conversationPhase,
          event.pending,
        );
        return conversationPhase === snapshot.conversationPhase
          ? snapshot
          : commit(event, { conversationPhase });
      }
      case "playback.changed": {
        const playback = event.playing ? "speaking" : "idle";
        return playback === snapshot.playback
          ? snapshot
          : commit(event, { playback });
      }
      case "attention.changed": {
        const attentionTarget = event.active ? "cursor" : "neutral";
        return attentionTarget === snapshot.attentionTarget
          ? snapshot
          : commit(event, { attentionTarget });
      }
      default:
        return assertNever(event);
    }
  }

  return {
    dispatch,
    getSnapshot: () => snapshot,
    dispose: () => {
      disposed = true;
    },
  };
}

function deriveMode(
  state: Omit<PresenceSnapshot, "revision" | "updatedAtMonotonicMs" | "lastTransition" | "mode">,
): PresenceMode {
  if (state.connectionStatus !== "connected") {
    return "offline";
  }
  if (state.playback === "speaking") {
    return "speaking";
  }
  if (state.conversationPhase === "interrupted") {
    return "interrupted";
  }
  if (state.conversationPhase === "settling") {
    return "settling";
  }
  if (state.conversationPhase === "preparing") {
    return "preparing";
  }
  if (state.conversationPhase === "thinking") {
    return "thinking";
  }
  if (state.microphone.status === "capturing" && !state.microphone.standby) {
    return "listening";
  }
  if (state.attentionTarget === "cursor") {
    return "noticing";
  }
  if (state.model.selection === "selected" && state.model.rendererStatus === "ready") {
    return "idle";
  }
  return "offline";
}

function freezeSnapshot(snapshot: PresenceSnapshot): Readonly<PresenceSnapshot> {
  if (snapshot.lastTransition) {
    Object.freeze(snapshot.lastTransition);
  }
  Object.freeze(snapshot.model);
  Object.freeze(snapshot.microphone);
  return Object.freeze(snapshot);
}

function resolvePreparationPhase(
  current: PresenceConversationPhase,
  pending: boolean,
): PresenceConversationPhase {
  if (pending) {
    return current === "idle" || current === "completed" || current === "failed"
      ? "preparing"
      : current;
  }
  return current === "preparing" ? "idle" : current;
}

function sameMicrophone(
  left: PresenceMicrophoneState,
  right: PresenceMicrophoneState,
): boolean {
  return left.status === right.status
    && (left.status !== "capturing"
      || (right.status === "capturing" && left.standby === right.standby));
}

function assertNever(value: never): never {
  throw new Error(`presence_event_unhandled:${JSON.stringify(value)}`);
}
