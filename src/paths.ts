import fs from "node:fs";
import path from "node:path";

/**
 * The absolute path with symlinks followed as far as the path exists, like Python's
 * Path.resolve(): a missing tail is kept as written, and a symlink loop never throws.
 */
export function resolvePath(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(resolvePath(parent), path.basename(abs));
  }
}
