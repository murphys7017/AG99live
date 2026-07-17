const { spawnSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const path = require("node:path");

const testsDir = path.join(".test-out", "tests");
const tests = readdirSync(testsDir)
  .filter((entry) => entry.endsWith(".test.js"))
  .sort();

if (tests.length === 0) {
  throw new Error("No compiled frontend tests were discovered.");
}

for (const test of tests) {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-specifier-resolution=node",
      path.join(testsDir, test),
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
