<script setup lang="ts">
import DesktopPetCanvas from "../components/DesktopPetCanvas.vue";
import { providePetDesktopRuntime } from "../app/usePetDesktopRuntime";

const {
  selectedModel,
  live2dPresentationSettings,
  stageMessage,
  showContextMenu,
} = providePetDesktopRuntime();
</script>

<template>
  <main
    class="desktop-shell desktop-shell--pet"
    @contextmenu.prevent="showContextMenu"
  >
    <DesktopPetCanvas
      :selected-model="selectedModel"
      :live2d-presentation-settings="live2dPresentationSettings"
      :stage-message="stageMessage"
    />
  </main>
</template>
