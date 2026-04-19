import path from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
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
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
