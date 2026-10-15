import fs from "node:fs";
import path from "node:path";

import { ENV_DIR, PROJECT_DIR } from "./environment.ts";
import { compareCodePoints } from "./text.ts";

export const PROJECT_FILE = "PROJECT.md";
export const RULES_DIR = "rules";
export const PROJECT_MAX_BYTES = 16384;

export class ProjectError extends Error {
  override name = "ProjectError";
}

export interface ProjectContext {
  /** Files that went into the text, relative to the project folder. */
  files: string[];
  text: string;
}

function readText(p: string): string {
  const bytes = fs.readFileSync(p);
  if (bytes.length > PROJECT_MAX_BYTES) {
    throw new ProjectError(`project file too large: ${p} is ${bytes.length} bytes (limit ${PROJECT_MAX_BYTES})`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replaceAll("\r\n", "\n").trim();
  } catch {
    throw new ProjectError(`project file cannot be read: ${p}: not valid UTF-8`);
  }
}

/**
 * The project's own description of how to test it: `.duckwright/PROJECT.md` and every
 * `.duckwright/rules/*.md`, in name order. Null when there is none, so a folder without a
 * project behaves as before.
 */
export function loadProject(cwd = process.cwd()): ProjectContext | null {
  const root = path.join(cwd, PROJECT_DIR);
  const parts: string[] = [];
  const files: string[] = [];
  const add = (rel: string, heading: string | null) => {
    const abs = path.join(root, rel);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (!st.isFile()) return;
    let text: string;
    try {
      text = readText(abs);
    } catch (e) {
      if (e instanceof ProjectError) throw e;
      throw new ProjectError(`project file cannot be read: ${abs}: ${(e as Error).message}`);
    }
    if (!text) return;
    files.push(rel);
    parts.push(heading ? `## Rule: ${heading}\n\n${text}` : text);
  };
  add(PROJECT_FILE, null);
  let rules: string[] = [];
  try {
    rules = fs.readdirSync(path.join(root, RULES_DIR));
  } catch {
    // no rules folder
  }
  for (const f of rules.filter((n) => !n.startsWith(".") && n.endsWith(".md")).sort(compareCodePoints)) {
    add(path.join(RULES_DIR, f), f.slice(0, -3));
  }
  return files.length ? { files, text: parts.join("\n\n") } : null;
}

const PROJECT_TEMPLATE = `<!-- Project context for the Duckwright agent: the agent reads this in every step.
     Describe the system under test, not how to code it. Keep it short (under 16 KB, rules included).
     Never put real passwords or tokens here: name where a credential comes from instead. -->

# Project name

## What it is

One or two sentences on the product and who uses it.

## Business terms

- Term: what it means here (for example "order" vs "quote").

## How to test it

- Where to start, the main flows, and what "working" looks like.
- Selectors, labels or wording the pages rely on, if they are not obvious.

## Do and don't

- Do: prefer the seeded test data.
- Don't: touch billing, delete customers, or send real emails.
`;

const RULE_TEMPLATE = `<!-- One topic per file in .duckwright/rules/. Example: auth, checkout, destructive-actions.
     The file name is the rule's title. Delete this comment after editing. -->

- State the rule as an instruction the agent can follow, and say why when it is not obvious.
`;

const ENV_TEMPLATE = `<!-- Environment context. Use it with: duckwright --env staging "<task>"
     Delete this comment after editing. Never put real passwords or tokens here. -->

# Staging

## Base URL

https://staging.example.com

## Test accounts

- member: member@example.com, password in the env var STAGING_MEMBER_PASSWORD

## Known quirks

- None yet.

## Off-limits

- Do not use the billing page.
`;

/** Writes the starter `.duckwright/` files that do not exist yet; returns the ones it wrote. */
export function scaffoldProject(cwd = process.cwd()): string[] {
  const root = path.join(cwd, PROJECT_DIR);
  const wanted: [string, string][] = [
    [path.join(root, PROJECT_FILE), PROJECT_TEMPLATE],
    [path.join(root, RULES_DIR, "destructive-actions.md"), RULE_TEMPLATE],
    [path.join(cwd, ENV_DIR, "staging.md"), ENV_TEMPLATE],
  ];
  const written: string[] = [];
  for (const [file, content] of wanted) {
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    written.push(path.relative(cwd, file));
  }
  return written;
}
