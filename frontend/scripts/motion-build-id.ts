import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function motionBuildId(root: string): string {
  const hash = createHash("sha256");
  function add(path: string): void {
    for (const item of readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const relative = path + "/" + item.name;
      if (item.isDirectory()) add(relative);
      else if (item.name.endsWith(".ts")) {
        hash.update(relative).update("\0").update(readFileSync(join(root, relative), "utf8").replace(/\r\n/g, "\n")).update("\0");
      }
    }
  }
  for (const path of ["src/model-engine", "src/live2d", "src/types", "src/live2d-renderer"]) add(path);
  return hash.digest("hex").slice(0, 16);
}
