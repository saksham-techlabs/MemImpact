// Removes build output directories. Usage: node scripts/clean.mjs [dir ...]
import { rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const targets = process.argv.slice(2);
const dirs = targets.length > 0 ? targets : ["dist", ".test-build"];
for (const dir of dirs) {
  const resolved = path.resolve(root, dir);
  if (!resolved.startsWith(root + path.sep)) throw new Error(`Refusing to remove ${resolved}`);
  rmSync(resolved, { recursive: true, force: true });
}
