import assert from "node:assert/strict";
import {
  buildAstrbotWebControlUrl,
  normalizeAstrbotWebUiUrl,
} from "../src/app/webControlUrl.js";

const baseUrl = "https://example.test/astrbot";
assert.equal(normalizeAstrbotWebUiUrl(baseUrl), `${baseUrl}/`);
assert.equal(
  buildAstrbotWebControlUrl(baseUrl),
  `${baseUrl}/#/plugin-view/astrbot_plugin_ag99live_adapter/control-panel`,
);
assert.throws(
  () => normalizeAstrbotWebUiUrl("https://admin:secret@example.test/astrbot"),
  /astrbot_webui_url_invalid/,
);
console.log("Web control URL boundary smoke passed.");
