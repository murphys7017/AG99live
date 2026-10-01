import { createApp } from "vue";
// The plugin control page is a scrolling document, not a fixed BrowserWindow.
// It must not import styles/desktop-app.css: that file carries the Electron
// window-shell reset (html/body/#app height:100% + overflow:hidden), which
// clips the page and makes the configuration unscrollable.
import "../styles/shared-components.css";
import "./theme.css";
import "./web-control.css";
import ControlPanelApp from "./ControlPanelApp.vue";

const bridge = window.AstrBotPluginView;
if (bridge) {
  void bridge.ready().then(() => {
    document.title = bridge.t("views.control-panel.title", "AG99live 控制台");
  });
}

createApp(ControlPanelApp).mount("#app");
