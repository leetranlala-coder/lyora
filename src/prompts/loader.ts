import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Prompts live in /prompts/*.md with a small front-matter header (name, version).
 * Bump `version` whenever a prompt changes — the version is written to the audit log
 * with every decision so bad conversations can be traced back to a prompt revision.
 */

export interface Prompt {
  name: string;
  version: string;
  body: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [resolve(here, "../../prompts"), resolve(here, "../../../prompts"), resolve(process.cwd(), "prompts")];

function promptsDir(): string {
  const dir = process.env.PROMPTS_DIR ?? candidates.find((d) => existsSync(d));
  if (!dir) throw new Error("prompts directory not found");
  return dir;
}

const cache = new Map<string, Prompt>();

export function loadPrompt(name: string): Prompt {
  const hit = cache.get(name);
  if (hit) return hit;
  const raw = readFileSync(join(promptsDir(), `${name}.md`), "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`prompt ${name} is missing front matter`);
  const meta = Object.fromEntries(
    m[1]!
      .split("\n")
      .map((l) => l.split(":").map((x) => x.trim()))
      .filter((p) => p.length >= 2)
      .map(([k, ...v]) => [k, v.join(":")]),
  );
  const prompt: Prompt = { name: meta.name ?? name, version: meta.version ?? "0", body: m[2]!.trim() };
  cache.set(name, prompt);
  return prompt;
}

/** Replace {{key}} placeholders. Unknown placeholders are left as-is so they're easy to spot. */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (all, k: string) => (k in vars ? vars[k]! : all));
}

export function clearPromptCache() {
  cache.clear();
}
