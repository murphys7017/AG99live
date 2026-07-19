declare module "@cubismsdksamples/main" {
  export function initializeLive2D(): Promise<void>;
}

declare module "@cubismsdksamples/lappdefine" {
  export let LIMITED_FRAME_RATE: number;

  export function updateModelConfig(
    resourcePath: string,
    modelDirectory: string,
    modelFileName: string,
    kScale?: number,
  ): void;
  export function applyRuntimeEffectsSettings(settings: {
    ambientMotionEnabled: boolean;
    physicsResponseScale: number;
  }): void;
}

declare module "@cubismsdksamples/lappdelegate" {
  export class LAppDelegate {
    static getInstance(): {
      onResize(): void;
    };

    static releaseInstance(): void;
  }
}
