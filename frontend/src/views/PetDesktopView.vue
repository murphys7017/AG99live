<script setup lang="ts">
import DesktopPetCanvas from "../components/DesktopPetCanvas.vue";
import { providePetDesktopRuntime } from "../app/usePetDesktopRuntime";

const { selectedModel, motionEngineSettings, stageMessage, showContextMenu } = providePetDesktopRuntime();
</script>

<template>
  <main
    class="desktop-shell desktop-shell--pet"
    @contextmenu.prevent="showContextMenu"
  >
    <DesktopPetCanvas
      :selected-model="selectedModel"
      :motion-engine-settings="motionEngineSettings"
      :stage-message="stageMessage"
    />
  </main>
</template>
