<script setup lang="ts">
import { computed } from "vue";
import ActionLabWindowView from "./views/ActionLabWindowView.vue";
import { getWindowRole } from "./app/useWindowRole";
import HistoryWindowView from "./views/HistoryWindowView.vue";
import PetDesktopView from "./views/PetDesktopView.vue";
import PetOverlayView from "./views/PetOverlayView.vue";
import ProfileEditorWindowView from "./views/ProfileEditorWindowView.vue";
import SettingsWindowView from "./views/SettingsWindowView.vue";
import Esp32DisplayPipelineHost from "./esp32-display/Esp32DisplayPipelineHost.vue";

const windowRole = computed(() => getWindowRole());
</script>

<template>
  <PetDesktopView v-if="windowRole === 'pet'" />
  <PetOverlayView v-else-if="windowRole === 'overlay'" />
  <SettingsWindowView v-else-if="windowRole === 'settings'" />
  <HistoryWindowView v-else-if="windowRole === 'history'" />
  <ActionLabWindowView v-else-if="windowRole === 'action_lab'" />
  <ProfileEditorWindowView v-else-if="windowRole === 'profile_editor'" />
  <PetDesktopView v-else />
  <Esp32DisplayPipelineHost v-if="windowRole === 'pet'" />
</template>
