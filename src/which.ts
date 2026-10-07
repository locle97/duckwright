import fs from "node:fs";
import path from "node:path";

/** Extensions Windows tries when a command has none, from PATHEXT. */
function winExts(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return raw.split(";").filter(Boolean);
}

/**
 * The first executable called `name` on PATH, like shutil.which. On Windows a
 * command is found through PATHEXT (`claude` -> `claude.exe` or `claude.cmd`).
 */
export function which(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const win = platform === "win32";
  const pathMod = win ? path.win32 : path;
  const exts = win ? (pathMod.extname(name) ? ["", ...winExts(env)] : winExts(env)) : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(pathMod.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = pathMod.join(dir, name + ext);
      try {
        if (!win) fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** A `.cmd`/`.bat` shim, which Windows can only start through cmd.exe. */
export const isBatchFile = (p: string): boolean => /\.(cmd|bat)$/i.test(p);

/** Quote one argument for cmd.exe running a batch shim (the cross-spawn rules, escaped twice). */
export function quoteForCmd(arg: string): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  a = `"${a}"`;
  const meta = /([()\][%!^"`<>&|;, *?])/g;
  return a.replace(meta, "^$1").replace(meta, "^$1");
}
