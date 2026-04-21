<script setup lang="ts">
import { computed } from "vue";
import ActionLabWindowView from "./views/ActionLabWindowView.vue";
import { getWindowRole } from "./composables/useWindowRole";
import HistoryWindowView from "./views/HistoryWindowView.vue";
import PetDesktopView from "./views/PetDesktopView.vue";
import PetOverlayView from "./views/PetOverlayView.vue";
import SettingsWindowView from "./views/SettingsWindowView.vue";

const windowRole = computed(() => getWindowRole());
</script>

<template>
  <PetDesktopView v-if="windowRole === 'pet'" />
  <PetOverlayView v-else-if="windowRole === 'overlay'" />
  <SettingsWindowView v-else-if="windowRole === 'settings'" />
  <HistoryWindowView v-else-if="windowRole === 'history'" />
  <ActionLabWindowView v-else-if="windowRole === 'action_lab'" />
  <PetDesktopView v-else />
</template>
