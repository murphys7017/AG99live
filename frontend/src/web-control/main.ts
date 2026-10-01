import { createApp } from "vue";
import "../style.css";
import "./web-control.css";
import ControlPanelApp from "./ControlPanelApp.vue";

const bridge = window.AstrBotPluginView;
if (bridge) {
  void bridge.ready().then(() => {
    document.title = bridge.t("views.control-panel.title", "AG99live 控制台");
  });
}

createApp(ControlPanelApp).mount("#app");
