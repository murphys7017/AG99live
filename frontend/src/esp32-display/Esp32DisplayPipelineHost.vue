<script setup lang="ts">
import { useEsp32DisplayConnection } from "./useEsp32DisplayConnection";
import { useEsp32DisplayPipeline } from "./useEsp32DisplayPipeline";
import { useEsp32DisplaySettings } from "./useEsp32DisplaySettings";

const { config } = useEsp32DisplaySettings();
const { connected } = useEsp32DisplayConnection();
useEsp32DisplayPipeline({
  config: () => config,
  connected,
});
</script>

<template>
  <span hidden aria-hidden="true"></span>
</template>
