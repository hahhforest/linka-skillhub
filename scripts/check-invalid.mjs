#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const argRepo = (() => {
  const idx = process.argv.indexOf("--repo");
  if (idx >= 0 && process.argv[idx + 1]) return path.resolve(process.argv[idx + 1]);
  return path.resolve("./.sandbox/my-skills-registry");
})();

const manifestPath = path.join(argRepo, "registry", "skills.json");
let manifest;
try {
  const raw = await fs.readFile(manifestPath, "utf8");
  manifest = JSON.parse(raw);
} catch (err) {
  process.stderr.write(`Cannot read manifest at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}

const invalid = manifest.skills.filter((s) => Array.isArray(s.status) && s.status.includes("invalid"));
process.stdout.write(`# Invalid skills in registry\n`);
process.stdout.write(`Repo: ${argRepo}\n`);
process.stdout.write(`Total skills: ${manifest.skills.length}\n`);
process.stdout.write(`Invalid: ${invalid.length}\n\n`);

if (invalid.length === 0) {
  process.exit(0);
}

process.stdout.write(`| id | name | source | issues |\n|---|---|---|---|\n`);
for (const skill of invalid) {
  const issues = (skill.issues ?? []).map((i) => `${i.code}: ${i.message}`).join("; ");
  process.stdout.write(`| ${skill.id} | ${skill.name} | ${skill.source?.agent}/${skill.source?.scope} | ${issues} |\n`);
}
process.exit(1);
