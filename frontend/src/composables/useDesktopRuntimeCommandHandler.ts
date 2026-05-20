import type { Ref } from "vue";
import type {
  DesktopMotionTuningSample,
  DesktopProfileAuthoringCommand,
  DesktopRuntimeCommand,
} from "../types/desktop.js";
import { cloneJson } from "../utils/cloneJson.js";
import type { useAdapterConnection } from "./useAdapterConnection.js";
import type { useDesktopBridge } from "./useDesktopBridge.js";
import type { usePetRuntimeSnapshotPublisher } from "./usePetRuntimeSnapshotPublisher.js";
import { applyMotionEngineSettingsSnapshot } from "./motionEngineSettingsSnapshot.js";
import type { ModelEngineSettings } from "../model-engine/settings.js";

export interface DesktopRuntimeCommandDeps {
  adapter: ReturnType<typeof useAdapterConnection>;
  bridge: ReturnType<typeof useDesktopBridge>;
  ambientMotionEnabled: Ref<boolean>;
  motionEngineSettings: ModelEngineSettings;
  modelEngine: {
    stop: (reason: string) => void;
    playPreviewPayload: (plan: unknown) => boolean;
  };
  snapshotPublisher: ReturnType<typeof usePetRuntimeSnapshotPublisher>;
  saveMotionTuningSample: (sample: DesktopMotionTuningSample) => void;
  deleteMotionTuningSample: (sampleId: string) => void;
  saveExpressionExampleOverride: (modelName: string, exampleId: string, enabled: boolean, feedback: string, tags: string[]) => void;
  deleteExpressionExampleOverride: (modelName: string, exampleId: string) => void;
  handlePreviewMotionPlan: (plan: unknown) => void;
  applyAmbientMotionPreference: () => void;
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
      case "set_ambient_motion_enabled":
        deps.ambientMotionEnabled.value = command.enabled;
        deps.applyAmbientMotionPreference();
        return;
      case "set_motion_engine_settings":
        applyMotionEngineSettingsSnapshot(deps.motionEngineSettings, command.settings);
        return;
      case "request_model_projection_sync":
        deps.snapshotPublisher.publishModelProjectionSnapshot();
        return;
      case "request_motion_tuning_samples_sync":
        deps.bridge.publishMotionTuningSamples(
          deps.adapter.state.motionTuningSamples,
          deps.adapter.state.motionTuningSamplesStatus,
        );
        return;
      case "save_motion_tuning_sample":
        deps.saveMotionTuningSample(command.sample);
        return;
      case "delete_motion_tuning_sample":
        deps.deleteMotionTuningSample(command.sampleId);
        return;
      case "save_expression_example_override":
        deps.saveExpressionExampleOverride(command.modelName, command.exampleId, command.enabled, command.feedback, command.tags);
        return;
      case "delete_expression_example_override":
        deps.deleteExpressionExampleOverride(command.modelName, command.exampleId);
        return;
      case "request_expression_example_sync":
        deps.snapshotPublisher.publishModelProjectionSnapshot();
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
