import { createApp } from "vue";
import App from "./App.vue";
import { getWindowRole } from "./app/useWindowRole";
import { createDesktopBridge, desktopBridgeKey } from "./desktop-bridge/useDesktopBridge";
import "./style.css";

const role = getWindowRole();
const roleTitles: Record<string, string> = {
  pet: "",
  overlay: "",
  settings: "AG99live 设置",
  history: "AG99live 历史",
  action_lab: "AG99live 动作实验室",
  profile_editor: "AG99live Profile Editor",
};

document.documentElement.dataset.windowRole = role;
document.body.dataset.windowRole = role;
document.title = roleTitles[role] ?? "AG99live";

const app = createApp(App);
const desktopBridge = createDesktopBridge();
desktopBridge.start();
app.provide(desktopBridgeKey, desktopBridge);
app.mount("#app");

window.addEventListener("beforeunload", () => {
  desktopBridge.dispose();
}, { once: true });
