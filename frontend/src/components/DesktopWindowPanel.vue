<script setup lang="ts">
import { useDesktopWindowActions } from "../desktop-bridge/useDesktopWindowActions";

defineProps<{
  title: string;
  subtitle: string;
}>();

const { minimizeWindow, closeWindow } = useDesktopWindowActions();
</script>

<template>
  <main class="desktop-panel">
    <header class="desktop-panel__header">
      <div>
        <p class="desktop-panel__eyebrow">{{ subtitle }}</p>
        <h1>{{ title }}</h1>
      </div>

      <div class="desktop-panel__window-actions">
        <button
          type="button"
          class="desktop-panel__window-button"
          @click="minimizeWindow"
        >
          最小化
        </button>
        <button
          type="button"
          class="desktop-panel__window-button desktop-panel__window-button--danger"
          @click="closeWindow"
        >
          关闭
        </button>
      </div>
    </header>

    <section class="desktop-panel__body">
      <slot />
    </section>
  </main>
</template>
