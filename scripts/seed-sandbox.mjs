#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sandbox = path.join(root, ".sandbox");

const skills = [
  {
    dir: "agents/mavis/skills/smart-commit",
    name: "smart-commit",
    description: "Summarize git changes and prepare a concise commit message.",
    body: "# Smart Commit\n\nRead git diff and produce a concise commit summary."
  },
  {
    dir: "agents/opencode/skills/apply-patch-helper",
    name: "apply-patch-helper",
    description: "Codex-specific patch helper that depends on functions.apply_patch.",
    body: "# Apply Patch Helper\n\nUse Codex `functions.apply_patch` to edit files."
  },
  {
    dir: "agents/claude/skills/invalid-skill",
    raw: "---\nname: invalid-skill\ndescription:\n  - invalid list\n---\n# Invalid\n"
  },
  {
    dir: "project/.opencode/skills/doc-builder",
    name: "doc-builder",
    description: "Build compact project documentation from source files.",
    body: "# Doc Builder\n\nCollect source evidence and write short docs."
  }
];

await fs.rm(sandbox, { recursive: true, force: true });
for (const skill of skills) {
  const dir = path.join(sandbox, skill.dir);
  await fs.mkdir(dir, { recursive: true });
  const content = skill.raw ?? `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${skill.body}\n`;
  await fs.writeFile(path.join(dir, "SKILL.md"), content, "utf8");
}

for (const agent of ["mavis", "opencode", "claude", "codex"]) {
  await fs.mkdir(path.join(sandbox, "agents", agent, "skills"), { recursive: true });
}

console.log(`Seeded sandbox skills under ${sandbox}`);
