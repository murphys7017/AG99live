import assert from "node:assert/strict";
import {
  matchesPinnedProfileScope,
  matchesProfileIdentityScope,
} from "../src/types/desktop.js";

function testPinnedScopeStillRequiresRevisionMatch(): void {
  assert.equal(
    matchesPinnedProfileScope(
      { profileId: "profile-1", profileRevision: 2 },
      { profile_id: "profile-1", revision: 3 },
    ),
    false,
  );
}

function testIdentityScopeIgnoresRevisionMismatch(): void {
  assert.equal(
    matchesProfileIdentityScope(
      { profileId: "profile-1" },
      { profile_id: "profile-1" },
    ),
    true,
  );
}

function run(): void {
  testPinnedScopeStillRequiresRevisionMatch();
  testIdentityScopeIgnoresRevisionMismatch();
  console.log("desktopProfileScope tests passed");
}

run();
