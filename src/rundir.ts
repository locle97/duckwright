// Names for run folders: `runs/<timestamp>-<label>/`.
import fs from "node:fs";
import path from "node:path";

export const ADJECTIVES: readonly string[] = [
  "brave", "bright", "calm", "clever", "cozy", "eager", "fancy", "gentle", "happy", "jolly",
  "keen", "kind", "lively", "lucky", "merry", "mighty", "nimble", "proud", "quick", "quiet",
  "rapid", "shiny", "silly", "snappy", "sunny", "swift", "tidy", "witty", "zany", "zesty",
];
export const NOUNS: readonly string[] = [
  "acorn", "badger", "beacon", "cedar", "comet", "dune", "ember", "falcon", "fern", "harbor",
  "heron", "island", "lagoon", "maple", "meadow", "otter", "pebble", "pine", "puffin", "quill",
  "raven", "reef", "river", "robin", "sparrow", "summit", "thistle", "tulip", "walrus", "willow",
];
export const MAX_LABEL = 40;

/**
 * Lowercase ASCII letters and digits joined by single dashes, at most MAX_LABEL long.
 * Accents are dropped first, so "Đăng nhập" becomes "dang-nhap".
 */
export function slugify(text: string): string {
  const ascii = text.toLowerCase().replaceAll("đ", "d").normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  const slug = ascii.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, MAX_LABEL).replace(/-+$/, "");
}

export function randomLabel(rng: () => number = Math.random): string {
  const pick = (words: readonly string[]) => words[Math.floor(rng() * words.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

/** The task file's name without its extension, or random words for a command-line task. */
export function runLabel(taskFile: string | null, rng?: () => number): string {
  const slug = taskFile !== null ? slugify(path.parse(taskFile).name) : "";
  return slug || randomLabel(rng);
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Create and return `root/<YYYYmmdd-HHMMSS>-<label>`, adding -2, -3, ... on a clash. */
export function makeRunDir(
  root: string, taskFile: string | null, now: Date = new Date(), rng?: () => number,
): string {
  const base = `${stamp(now)}-${runLabel(taskFile, rng)}`;
  fs.mkdirSync(root, { recursive: true });
  for (let n = 1; ; n++) {
    const p = path.join(root, n === 1 ? base : `${base}-${n}`);
    try {
      fs.mkdirSync(p);
      return p;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}
