import assert from "node:assert/strict";
import { createDesktopSettingsResponder } from "../src/adapter-connection/features/desktopSettings.js";
import {
  ESP32_DISPLAY_DEFAULT_CONFIG,
  cloneConfig,
  type Esp32DisplayConfig,
} from "../src/esp32-display/types.js";
import type {
  ProtocolEnvelope,
  SystemDesktopSettingsQueryPayload,
  SystemDesktopSettingsResultPayload,
} from "../src/types/protocol.js";

function queryEnvelope(
  key: string,
  action: "list" | "set",
  value?: string,
): ProtocolEnvelope<SystemDesktopSettingsQueryPayload> {
  return {
    type: "system.desktop_settings_query",
    version: "v2",
    message_id: `settings-${key}-${action}`,
    timestamp: new Date().toISOString(),
    turn_id: null,
    source: "adapter",
    payload: {
      request_id: `request-${key}-${action}`,
      key,
      action,
      value,
    },
  };
}

async function run(): Promise<void> {
  const scalarSettings = {
    screenshotOnSend: true,
    pttModeEnabled: false,
    ambientMotionEnabled: true,
    physicsResponseScale: 1,
    renderDprCap: 1.25,
    motionIntensityScale: 1.35,
  };
  const scalarAccess = {
    currentDesktopScreenshotOnSendEnabled: () => scalarSettings.screenshotOnSend,
    applyDesktopScreenshotOnSendEnabled: (enabled: boolean) => {
      scalarSettings.screenshotOnSend = enabled;
    },
    currentPttModeEnabled: () => scalarSettings.pttModeEnabled,
    applyPttModeEnabled: (enabled: boolean) => {
      scalarSettings.pttModeEnabled = enabled;
    },
    runtimeSettings: {
      currentAmbientMotionEnabled: () => scalarSettings.ambientMotionEnabled,
      applyAmbientMotionEnabled: (enabled: boolean) => {
        scalarSettings.ambientMotionEnabled = enabled;
      },
      currentPhysicsResponseScale: () => scalarSettings.physicsResponseScale,
      applyPhysicsResponseScale: (scale: number) => {
        scalarSettings.physicsResponseScale = scale;
      },
      currentRenderDprCap: () => scalarSettings.renderDprCap,
      applyRenderDprCap: (cap: number) => {
        scalarSettings.renderDprCap = cap;
      },
      currentMotionIntensityScale: () => scalarSettings.motionIntensityScale,
      applyMotionIntensityScale: (scale: number) => {
        scalarSettings.motionIntensityScale = scale;
      },
    },
  };
  let spoutEnabled = false;
  let esp32Config: Esp32DisplayConfig = cloneConfig(ESP32_DISPLAY_DEFAULT_CONFIG);
  let appliedEsp32ConfigCount = 0;
  const replies: SystemDesktopSettingsResultPayload[] = [];
  const responder = createDesktopSettingsResponder({
    ...scalarAccess,
    currentMicrophoneDeviceId: () => "",
    applyMicrophoneDevice: () => undefined,
    currentSpoutEnabled: () => spoutEnabled,
    applySpoutEnabled: (enabled) => {
      spoutEnabled = enabled;
    },
    currentEsp32DisplayConfig: () => cloneConfig(esp32Config),
    applyEsp32DisplayConfig: async (next) => {
      esp32Config = cloneConfig(next);
      appliedEsp32ConfigCount += 1;
    },
  }, (reply) => replies.push(reply));

  await responder(queryEnvelope("desktop_screenshot_on_send", "set", "false"));
  assert.equal(scalarSettings.screenshotOnSend, false);
  assert.equal(replies.at(-1)?.value, "false");
  await responder(queryEnvelope("ptt_mode_enabled", "set", "true"));
  assert.equal(scalarSettings.pttModeEnabled, true);
  await responder(queryEnvelope("live2d_ambient_motion_enabled", "set", "false"));
  assert.equal(scalarSettings.ambientMotionEnabled, false);
  await responder(queryEnvelope("live2d_physics_response_scale", "set", "1.5"));
  assert.equal(scalarSettings.physicsResponseScale, 1.5);
  await responder(queryEnvelope("live2d_render_dpr_cap", "list"));
  assert.equal(replies.at(-1)?.value, "1.25");
  assert.equal(replies.at(-1)?.minimum, 1);
  assert.equal(replies.at(-1)?.maximum, 2.5);
  await responder(queryEnvelope("motion_engine_intensity_scale", "set", "3"));
  assert.equal(replies.at(-1)?.ok, false);
  assert.equal(replies.at(-1)?.error, "desktop_setting_value_out_of_range");
  assert.equal(scalarSettings.motionIntensityScale, 1.35);

  await responder(queryEnvelope("spout_enabled", "set", "true"));
  assert.equal(spoutEnabled, true);
  assert.equal(replies.at(-1)?.ok, true);
  assert.equal(replies.at(-1)?.value, "true");

  await responder(queryEnvelope("esp32_display_crop_w", "set", "0.8"));
  assert.equal(esp32Config.crop.w, 0.8);
  await responder(queryEnvelope("esp32_display_crop_x", "list"));
  assert.ok(Math.abs((replies.at(-1)?.maximum ?? 0) - 0.2) < 1e-9);

  await responder(queryEnvelope("esp32_display_crop_x", "set", "0.15"));
  assert.equal(esp32Config.crop.x, 0.15);
  assert.equal(replies.at(-1)?.value, "0.15");

  const appliedCountBeforeReject = appliedEsp32ConfigCount;
  await responder(queryEnvelope("esp32_display_crop_x", "set", "0.25"));
  assert.equal(replies.at(-1)?.ok, false);
  assert.equal(replies.at(-1)?.error, "desktop_setting_value_out_of_range");
  assert.equal(appliedEsp32ConfigCount, appliedCountBeforeReject);

  let concurrentConfig = cloneConfig(ESP32_DISPLAY_DEFAULT_CONFIG);
  const concurrentResponder = createDesktopSettingsResponder({
    ...scalarAccess,
    currentMicrophoneDeviceId: () => "",
    applyMicrophoneDevice: () => undefined,
    currentSpoutEnabled: () => false,
    applySpoutEnabled: () => undefined,
    currentEsp32DisplayConfig: () => cloneConfig(concurrentConfig),
    applyEsp32DisplayConfig: async (next) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      concurrentConfig = cloneConfig(next);
    },
  }, () => undefined);

  await Promise.all([
    concurrentResponder(queryEnvelope("esp32_display_crop_w", "set", "0.8")),
    concurrentResponder(queryEnvelope("esp32_display_crop_x", "set", "0.15")),
  ]);
  assert.equal(concurrentConfig.crop.w, 0.8);
  assert.equal(concurrentConfig.crop.x, 0.15);

  console.log("desktopSettingsResponder tests passed");
}

void run();
