import path from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  root: path.resolve(__dirname, "web-control"),
  base: "./",
  plugins: [vue()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@framework": path.resolve(
        __dirname,
        "./src/live2d/WebSDK/Framework/src",
      ),
      "@cubismsdksamples": path.resolve(__dirname, "./src/live2d/WebSDK/src"),
    },
  },
  build: {
    outDir: path.resolve(
      __dirname,
      "../astrbot_plugin_ag99live_adapter/views/control-panel",
    ),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
});
