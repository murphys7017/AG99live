const { rmSync } = require("node:fs");
const { spawnSync } = require("node:child_process");

rmSync(".test-out", { recursive: true, force: true });

const result = spawnSync(
  process.execPath,
  [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.test.json", "--outDir", ".test-out"],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
