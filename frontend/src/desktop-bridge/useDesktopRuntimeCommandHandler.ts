import type {
  DesktopMicrophoneDevice,
  DesktopMotionTuningSample,
  DesktopMotionTuningSamplesStatus,
  DesktopPttKeyBinding,
  DesktopProfileAuthoringCommand,
  DesktopRuntimeCommand,
} from "../types/desktop.js";
import type { SystemSemanticAxisProfileSavePayload } from "../types/protocol.js";
import { cloneJson } from "../utils/cloneJson.js";
import {
  applyModelEngineSettings,
  type ModelEngineSettings,
} from "../model-engine/settings.js";
import {
  applyLive2dPresentationSettingsSnapshot,
  type Live2dPresentationSettings,
} from "../live2d-renderer/settings.js";
import type { BilibiliLiveSettings } from "../types/bilibili-live.js";

interface DesktopRuntimeCommandAdapterPort {
  readonly state: {
    readonly motionTuningSamples: readonly unknown[];
    readonly motionTuningSamplesStatus: DesktopMotionTuningSamplesStatus;
  };
  setAddress: (address: string) => void;
  setDesktopScreenshotOnSendEnabled: (enabled: boolean) => void;
  setMicrophoneDevice: (deviceId: string) => void;
  setMicrophoneDevices: (devices: DesktopMicrophoneDevice[]) => void;
  refreshMicrophoneDevices: () => Promise<void>;
  requestHistoryList: () => boolean;
  createHistory: () => boolean;
  loadHistory: (historyUid: string) => boolean;
  deleteHistory: (historyUid: string) => boolean;
  connect: () => void;
  disconnect: () => void;
  sendText: (text: string) => Promise<boolean>;
  interruptCurrentTurn: () => boolean;
  toggleMicrophoneCapture: () => Promise<unknown>;
  setPttMode: (enabled: boolean) => void;
  setPttKeyBinding: (binding: DesktopPttKeyBinding) => void;
  sendSemanticAxisProfileSave: (payload: SystemSemanticAxisProfileSavePayload) => boolean;
}

interface DesktopRuntimeSnapshotPublisherPort {
  publishRuntimeSnapshot: () => void;
  publishMotionTuningSamples: () => void;
  publishModelProjectionSnapshot: () => void;
}

export interface DesktopRuntimeCommandDeps {
  adapter: DesktopRuntimeCommandAdapterPort;
  motionEngineSettings: ModelEngineSettings;
  live2dPresentationSettings: Live2dPresentationSettings;
  modelEngine: {
    stop: (reason: string) => void;
    playPreviewPayload: (plan: unknown) => boolean;
  };
  snapshotPublisher: DesktopRuntimeSnapshotPublisherPort;
  saveMotionTuningSample: (sample: DesktopMotionTuningSample) => void;
  deleteMotionTuningSample: (sampleId: string) => void;
  handlePreviewMotionPlan: (plan: unknown) => void;
  setBilibiliLiveSettings: (settings: BilibiliLiveSettings) => void;
}

export function createDesktopRuntimeCommandHandler(
  deps: DesktopRuntimeCommandDeps,
): {
  handleCommand: (command: DesktopRuntimeCommand) => void;
  handleProfileAuthoringCommand: (command: DesktopProfileAuthoringCommand) => void;
} {
  function handleCommand(command: DesktopRuntimeCommand): void {
    switch (command.type) {
      case "set_address":
        deps.adapter.setAddress(command.address);
        return;
      case "set_desktop_screenshot_on_send":
        deps.adapter.setDesktopScreenshotOnSendEnabled(command.enabled);
        return;
      case "set_microphone_device":
        deps.adapter.setMicrophoneDevice(command.deviceId);
        return;
      case "set_microphone_devices":
        deps.adapter.setMicrophoneDevices(command.devices);
        return;
      case "refresh_microphone_devices":
        void deps.adapter.refreshMicrophoneDevices();
        return;
      case "set_motion_engine_settings":
        applyModelEngineSettings(deps.motionEngineSettings, command.settings);
        return;
      case "set_live2d_presentation_settings":
        applyLive2dPresentationSettingsSnapshot(
          deps.live2dPresentationSettings,
          command.settings,
        );
        return;
      case "request_model_projection_sync":
        deps.snapshotPublisher.publishModelProjectionSnapshot();
        return;
      case "request_motion_tuning_samples_sync":
        deps.snapshotPublisher.publishMotionTuningSamples();
        return;
      case "save_motion_tuning_sample":
        deps.saveMotionTuningSample(command.sample);
        return;
      case "delete_motion_tuning_sample":
        deps.deleteMotionTuningSample(command.sampleId);
        return;
      case "request_history_list":
        deps.adapter.requestHistoryList();
        return;
      case "create_history":
        deps.adapter.createHistory();
        return;
      case "load_history":
        deps.adapter.loadHistory(command.historyUid);
        return;
      case "delete_history":
        deps.adapter.deleteHistory(command.historyUid);
        return;
      case "connect":
        if (typeof command.address === "string") {
          deps.adapter.setAddress(command.address);
        }
        deps.adapter.connect();
        return;
      case "disconnect":
        deps.adapter.disconnect();
        return;
      case "send_text":
        void deps.adapter.sendText(command.text);
        return;
      case "interrupt":
        deps.modelEngine.stop("interrupted");
        deps.adapter.interruptCurrentTurn();
        return;
      case "toggle_mic_capture":
        void deps.adapter.toggleMicrophoneCapture();
        return;
      case "set_ptt_mode":
        deps.adapter.setPttMode(command.enabled);
        return;
      case "set_ptt_key_binding":
        deps.adapter.setPttKeyBinding(command.binding);
        return;
      case "set_bilibili_live_settings":
        deps.setBilibiliLiveSettings(command.settings);
        return;
      case "preview_motion_payload":
        deps.handlePreviewMotionPlan(command.payload);
        return;
    }
  }

  function handleProfileAuthoringCommand(
    command: DesktopProfileAuthoringCommand,
  ): void {
    if (command.type !== "save_semantic_axis_profile") {
      return;
    }

    deps.adapter.sendSemanticAxisProfileSave({
      request_id: command.requestId,
      model_name: command.modelName,
      profile_id: command.profileId,
      expected_revision: command.expectedRevision,
      profile: cloneJson(command.profile),
    });
  }

  return {
    handleCommand,
    handleProfileAuthoringCommand,
  };
}
