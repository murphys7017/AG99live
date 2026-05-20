import { watch, type Ref } from "vue";

export interface AmbientMotionPreferenceController {
  applyAmbientMotionPreference: (attemptsRemaining?: number) => void;
}

export function useAmbientMotionPreference(
  enabled: Ref<boolean>,
  options: {
    getModelUrl: () => string;
  },
): AmbientMotionPreferenceController {
  function applyAmbientMotionPreference(attemptsRemaining = 12): void {
    const live2dAdapter = window.getLAppAdapter?.();
    if (live2dAdapter?.setAmbientMotionEnabled) {
      live2dAdapter.setAmbientMotionEnabled(enabled.value);
      return;
    }

    if (attemptsRemaining <= 0) {
      return;
    }

    window.setTimeout(() => {
      applyAmbientMotionPreference(attemptsRemaining - 1);
    }, 120);
  }

  watch(
    () => [options.getModelUrl(), enabled.value],
    () => {
      applyAmbientMotionPreference();
    },
    { immediate: true },
  );

  return {
    applyAmbientMotionPreference,
  };
}
