#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const root = process.cwd();
const home = os.homedir();
const mirrorRoot = path.join(root, ".sandbox", "local-mirror");
const expand = (input) => input.startsWith("~/") ? path.join(home, input.slice(2)) : input;

const sources = [
  { label: "codex user", source: "~/.codex/skills", dest: "sources/codex/skills", mode: "direct", exclude: new Set([".system"]) },
  { label: "codex system", source: "~/.codex/skills/.system", dest: "sources/codex/system", mode: "direct" },
  { label: "claude user", source: "~/.claude/skills", dest: "sources/claude/skills", mode: "direct" },
  { label: "opencode config", source: "~/.config/opencode/skills", dest: "sources/opencode/config-skills", mode: "direct" },
  { label: "opencode home", source: "~/.opencode/skills", dest: "sources/opencode/home-skills", mode: "direct" },
  { label: "shared agents", source: "~/.agents/skills", dest: "sources/shared-agents/skills", mode: "direct" },
  { label: "mavis user", source: "~/.mavis/skills", dest: "sources/mavis/skills", mode: "direct" },
  { label: "mavis builtin", source: "~/.mavis/.builtin-skills", dest: "sources/mavis/builtin", mode: "direct" },
  { label: "mavis agent-private", source: "~/.mavis/agents", dest: "sources/mavis/agent-private", mode: "nested-skills" },
  { label: "cursor user", source: "~/.cursor/skills-cursor", dest: "sources/cursor/skills", mode: "direct" },
  { label: "openclaw user", source: "~/.openclaw/workspace/skills", dest: "sources/openclaw/skills", mode: "direct" },
  { label: "hermes user", source: "~/.hermes/skills", dest: "sources/hermes/skills", mode: "nested-recursive" }
];

const targets = [
  { label: "codex target", source: "~/.codex/skills", dest: "targets/codex/skills", mode: "direct", exclude: new Set([".system"]) },
  { label: "claude target", source: "~/.claude/skills", dest: "targets/claude/skills", mode: "direct" },
  { label: "opencode target", source: "~/.config/opencode/skills", dest: "targets/opencode/skills", mode: "direct" },
  { label: "mavis target", source: "~/.mavis/skills", dest: "targets/mavis/skills", mode: "direct" },
  { label: "shared-agents target", source: "~/.agents/skills", dest: "targets/shared-agents/skills", mode: "direct" },
  { label: "cursor target", source: "~/.cursor/skills-cursor", dest: "targets/cursor/skills", mode: "direct" },
  { label: "openclaw target", source: "~/.openclaw/workspace/skills", dest: "targets/openclaw/skills", mode: "direct" },
  { label: "hermes target", source: "~/.hermes/skills", dest: "targets/hermes/skills", mode: "nested-recursive" }
];

const exists = async (target) => {
  try { await fs.access(target); return true; } catch { return false; }
};

const hasSkill = async (dir) => exists(path.join(dir, "SKILL.md"));

const copySkillPackage = async (sourceDir, destDir) => {
  await fs.rm(destDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  await fs.cp(sourceDir, destDir, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== ".DS_Store" && base !== "node_modules" && base !== ".git";
    }
  });
};

const copyDirect = async (entry) => {
  const sourceRoot = expand(entry.source);
  const destRoot = path.join(mirrorRoot, entry.dest);
  await fs.rm(destRoot, { recursive: true, force: true });
  await fs.mkdir(destRoot, { recursive: true });
  if (!(await exists(sourceRoot))) return { ...entry, sourceRoot, destRoot, copied: 0, missing: true };

  let copied = 0;
  if (await hasSkill(sourceRoot)) {
    await copySkillPackage(sourceRoot, destRoot);
    copied += 1;
  } else {
    const children = await fs.readdir(sourceRoot, { withFileTypes: true });
    for (const child of children) {
      if ((!child.isDirectory() && !child.isSymbolicLink()) || entry.exclude?.has(child.name)) continue;
      const sourceDir = path.join(sourceRoot, child.name);
      if (!(await hasSkill(sourceDir))) continue;
      await copySkillPackage(sourceDir, path.join(destRoot, child.name));
      copied += 1;
    }
  }
  return { ...entry, sourceRoot, destRoot, copied };
};

const copyNestedSkills = async (entry) => {
  const sourceRoot = expand(entry.source);
  const destRoot = path.join(mirrorRoot, entry.dest);
  await fs.rm(destRoot, { recursive: true, force: true });
  await fs.mkdir(destRoot, { recursive: true });
  if (!(await exists(sourceRoot))) return { ...entry, sourceRoot, destRoot, copied: 0, missing: true };

  let copied = 0;
  const agents = await fs.readdir(sourceRoot, { withFileTypes: true });
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const skillsRoot = path.join(sourceRoot, agent.name, "skills");
    if (!(await exists(skillsRoot))) continue;
    const skillDirs = await fs.readdir(skillsRoot, { withFileTypes: true });
    for (const skillDirEntry of skillDirs) {
      if (!skillDirEntry.isDirectory() && !skillDirEntry.isSymbolicLink()) continue;
      const skillDir = path.join(skillsRoot, skillDirEntry.name);
      if (!(await hasSkill(skillDir))) continue;
      await copySkillPackage(skillDir, path.join(destRoot, agent.name, "skills", skillDirEntry.name));
      copied += 1;
    }
  }
  return { ...entry, sourceRoot, destRoot, copied };
};

// Hermes (NousResearch/hermes-agent) groups skills under category folders with
// mixed depth: some skills sit directly under <root>/<skill>/SKILL.md while
// others live under <root>/<category>/<skill>/SKILL.md. Walk recursively up to
// depth 3, copy whole skill packages preserving the relative path so the
// sandbox source matches the on-disk layout the scanner will see when reading
// the real ~/.hermes/skills/.
const copyNestedRecursive = async (entry) => {
  const sourceRoot = expand(entry.source);
  const destRoot = path.join(mirrorRoot, entry.dest);
  await fs.rm(destRoot, { recursive: true, force: true });
  await fs.mkdir(destRoot, { recursive: true });
  if (!(await exists(sourceRoot))) return { ...entry, sourceRoot, destRoot, copied: 0, missing: true };

  let copied = 0;
  const walk = async (current, depth) => {
    if (depth > 3) return;
    if (await hasSkill(current)) {
      const rel = path.relative(sourceRoot, current);
      await copySkillPackage(current, path.join(destRoot, rel));
      copied += 1;
      return;
    }
    const children = await fs.readdir(current, { withFileTypes: true });
    for (const child of children) {
      if ((!child.isDirectory() && !child.isSymbolicLink()) || child.name === ".DS_Store" || child.name === "node_modules" || child.name === ".git") continue;
      await walk(path.join(current, child.name), depth + 1);
    }
  };
  await walk(sourceRoot, 0);
  return { ...entry, sourceRoot, destRoot, copied };
};

await fs.rm(mirrorRoot, { recursive: true, force: true });
await fs.mkdir(mirrorRoot, { recursive: true });
const results = [];
for (const entry of [...sources, ...targets]) {
  if (entry.mode === "nested-skills") results.push(await copyNestedSkills(entry));
  else if (entry.mode === "nested-recursive") results.push(await copyNestedRecursive(entry));
  else results.push(await copyDirect(entry));
}

const summary = {
  mirrorRoot,
  totalCopiedSkillPackages: results.reduce((sum, item) => sum + item.copied, 0),
  results: results.map(({ exclude, ...item }) => item)
};
await fs.writeFile(path.join(mirrorRoot, "mirror-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));
