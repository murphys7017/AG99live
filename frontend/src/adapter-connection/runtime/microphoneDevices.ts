export interface MicrophoneDeviceInfo {
  deviceId: string;
  label: string;
}

export interface ListMicrophoneInputDevicesOptions {
  requestPermission?: boolean;
  permissionTimeoutMs?: number;
}

const MICROPHONE_PERMISSION_TIMEOUT_MS = 4000;

export async function listMicrophoneInputDevices(
  options: ListMicrophoneInputDevicesOptions = {},
): Promise<MicrophoneDeviceInfo[]> {
  if (typeof navigator === "undefined") {
    return [];
  }

  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices?.enumerateDevices) {
    return [];
  }

  let devices = await mediaDevices.enumerateDevices();
  if (options.requestPermission && shouldRequestPermissionForDeviceList(devices)) {
    await unlockMicrophoneDeviceEnumeration(
      mediaDevices,
      options.permissionTimeoutMs ?? MICROPHONE_PERMISSION_TIMEOUT_MS,
    );
    devices = await mediaDevices.enumerateDevices();
  }

  return devices
    .filter((device) => device.kind === "audioinput")
    .map((device, index) => ({
      deviceId: device.deviceId.trim(),
      label: device.label.trim() || `麦克风 ${index + 1}`,
    }))
    .filter((device) => device.deviceId.length > 0);
}

function shouldRequestPermissionForDeviceList(devices: MediaDeviceInfo[]): boolean {
  const audioInputs = devices.filter((device) => device.kind === "audioinput");
  if (!audioInputs.length) {
    return true;
  }

  return audioInputs.every((device) => !device.label.trim());
}

async function unlockMicrophoneDeviceEnumeration(
  mediaDevices: MediaDevices,
  timeoutMs: number,
): Promise<void> {
  if (!mediaDevices.getUserMedia) {
    return;
  }

  let resolvedStream: MediaStream | null = null;
  const permissionRequest = mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });
  permissionRequest
    .then((stream) => {
      if (resolvedStream !== stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
    })
    .catch(() => {
      // The awaited race below reports the failure to the caller.
    });

  const stream = await withTimeout(
    permissionRequest,
    timeoutMs,
    "麦克风权限请求超时，已继续使用系统默认麦克风。",
  );
  resolvedStream = stream;
  stream.getTracks().forEach((track) => track.stop());
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timerId = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        window.clearTimeout(timerId);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timerId);
        reject(error);
      },
    );
  });
}
