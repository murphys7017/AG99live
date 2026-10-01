/**
 * 桌面端本机配置的应答端。
 *
 * 适配器只做转发，真正知道"这台电脑上有什么"的是这里。每一项配置在这里声明一次
 * list/set，之后控制页要加新控件就不必再动协议、入站管线或 Web API。
 *
 * 形状对所有配置都是同一个：当前值 + 选项列表。选项就是客户端实际拥有的东西
 * （麦克风设备来自系统枚举，按键来自 DOM code 表），用户从里面选。
 */

import type {
  ProtocolEnvelope,
  SystemDesktopSettingOption,
  SystemDesktopSettingsQueryPayload,
  SystemDesktopSettingsResultPayload,
} from "../../types/protocol.js";
import { listMicrophoneInputDevices } from "../runtime/microphoneDevices.js";

export interface DesktopSettingEntry {
  value: string;
  options: SystemDesktopSettingOption[];
}

/** Desktop-local state this responder reads and mutates. */
export interface DesktopSettingAccess {
  currentMicrophoneDeviceId: () => string;
  applyMicrophoneDevice: (deviceId: string) => void;
}

interface DesktopSettingHandler {
  list: () => Promise<DesktopSettingEntry>;
  set: (value: string) => Promise<DesktopSettingEntry>;
}

async function microphoneDeviceOptions(): Promise<SystemDesktopSettingOption[]> {
  const devices = await listMicrophoneInputDevices({ requestPermission: true });
  return devices.map((device) => ({ id: device.deviceId, label: device.label }));
}

function microphoneDeviceHandler(access: DesktopSettingAccess): DesktopSettingHandler {
  return {
    list: async () => ({
      value: access.currentMicrophoneDeviceId(),
      options: await microphoneDeviceOptions(),
    }),
    set: async (value) => {
      const options = await microphoneDeviceOptions();
      // Only accept a device this desktop actually reported, so a stale page
      // cannot push an arbitrary id into the capture runtime.
      if (!options.some((option) => option.id === value)) {
        throw new Error("desktop_setting_value_not_available");
      }
      access.applyMicrophoneDevice(value);
      return { value, options };
    },
  };
}

const DESKTOP_SETTING_HANDLERS: Record<
  string,
  (access: DesktopSettingAccess) => DesktopSettingHandler
> = {
  microphone_device: microphoneDeviceHandler,
};

export function createDesktopSettingsResponder(
  access: DesktopSettingAccess,
  send: (payload: SystemDesktopSettingsResultPayload) => void,
): (
  envelope: ProtocolEnvelope<SystemDesktopSettingsQueryPayload>,
) => Promise<void> {
  return async function handleDesktopSettingsQuery(
    envelope: ProtocolEnvelope<SystemDesktopSettingsQueryPayload>,
  ): Promise<void> {
    const { request_id: requestId, key, action, value } = envelope.payload;
    const createHandler = DESKTOP_SETTING_HANDLERS[key];
    if (!createHandler) {
      send({
        request_id: requestId,
        key,
        ok: false,
        error: "desktop_setting_unsupported",
      });
      return;
    }

    const handler = createHandler(access);
    try {
      const entry =
        action === "set" ? await handler.set(value ?? "") : await handler.list();
      send({
        request_id: requestId,
        key,
        ok: true,
        value: entry.value,
        options: entry.options,
      });
    } catch (error) {
      send({
        request_id: requestId,
        key,
        ok: false,
        error: error instanceof Error ? error.message : "desktop_setting_failed",
      });
    }
  };
}
