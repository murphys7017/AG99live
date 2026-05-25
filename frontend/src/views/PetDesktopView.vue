<script setup lang="ts">
import DesktopPetCanvas from "../components/DesktopPetCanvas.vue";
import { usePetDesktopController } from "../app/usePetDesktopController";
import { providePetDesktopRuntime } from "../app/usePetDesktopRuntime";

providePetDesktopRuntime();
const { selectedModel, stageMessage, showContextMenu } = usePetDesktopController();
</script>

<template>
  <main
    class="desktop-shell desktop-shell--pet"
    @contextmenu.prevent="showContextMenu"
  >
    <DesktopPetCanvas
      :selected-model="selectedModel"
      :stage-message="stageMessage"
    />
  </main>
</template>
