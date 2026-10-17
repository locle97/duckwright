// The chat agent's system prompt: the duckwright-autotest skill, without front matter, with the skills folder filled in.
import { readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_SKILLS_DIR = path.resolve(import.meta.dirname, "../../skills");

const INTRO = "You are running inside Duckwright's web chat. The person reads your messages in a browser.";

export function chatSystemPrompt(skillsDir: string): string {
  const raw = readFileSync(path.join(DEFAULT_SKILLS_DIR, "duckwright-autotest", "SKILL.md"), "utf8");
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
  return `${INTRO}\n\n${body.split("{{SKILLS}}").join(skillsDir)}\n`;
}
