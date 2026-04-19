import { createApp } from "vue";
import App from "./App.vue";
import { getWindowRole } from "./composables/useWindowRole";
import "./style.css";

const role = getWindowRole();
document.documentElement.dataset.windowRole = role;
document.body.dataset.windowRole = role;

createApp(App).mount("#app");
