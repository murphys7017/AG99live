<script setup lang="ts">
defineProps<{
  title: string;
  subtitle: string;
}>();

function minimizeWindow(): void {
  window.ag99desktop?.minimizeCurrentWindow();
}

function closeWindow(): void {
  window.ag99desktop?.closeCurrentWindow();
}
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
