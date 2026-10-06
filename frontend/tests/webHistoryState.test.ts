import assert from "node:assert/strict";
import { normalizeWebHistoryState } from "../src/web-control/useWebHistory.js";

const response = {
  platform_id: "ag99live-local",
  active_history_uid: "new-history",
  history_uid: "saved-history",
  histories: [{ uid: "new-history", latest_message: null, timestamp: "2026-10-06T00:00:00Z" }],
  messages: [{
    id: "saved-history-tool-1",
    role: "ai",
    type: "tool_call_status",
    tool_name: "search",
    content: "Completed",
    timestamp: "2026-10-06T00:00:00Z",
  }],
};
const state = normalizeWebHistoryState(response, "ag99live-local");
assert.equal(state.activeHistoryUid, "new-history");
assert.equal(state.viewedHistoryUid, "saved-history");
assert.equal(state.histories[0].latestMessage, null);
assert.equal(state.messages[0].toolName, "search");
assert.throws(() => normalizeWebHistoryState(response, "other-platform"), /history_response_invalid/);
console.log("Web history response boundary smoke passed.");
